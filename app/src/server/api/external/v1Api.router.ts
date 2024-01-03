import { TRPCError } from "@trpc/server";
import { type ChatCompletionChunk, type ChatCompletion } from "openai/resources/chat";
import { Stream } from "openai/streaming";
import { APIError } from "openai";
import { z } from "zod";
import { captureException } from "@sentry/node";
import { type FineTune } from "@prisma/client";
import { ExtendedTRPCError } from "trpc-openapi";

import { getCompletion2 } from "~/modelProviders/fine-tuned/getCompletion-2";
import { prisma } from "~/server/db";
import {
  chatCompletionInputReqPayload,
  chatCompletionOutput,
  chatMessage,
  functionCallInput,
  functionsInput,
  toolChoiceInput,
  toolsInput,
} from "~/types/shared.types";
import { createOpenApiRouter, openApiProtectedProc } from "./openApiTrpc";
import { typedFineTune } from "~/types/dbColumns.types";
import {
  type CalculatedUsage,
  calculateUsage,
  recordLoggedCall,
  recordUsage,
  reqValidator,
} from "~/utils/recordRequest";
import { getOpenaiCompletion } from "~/server/utils/openai";
import { parseTags } from "~/server/utils/parseTags";
import { statusCodeFromTrpcCode, trpcCodeFromHttpStatus } from "~/server/utils/trpcStatusCodes";

export const v1ApiRouter = createOpenApiRouter({
  checkCache: openApiProtectedProc
    .meta({
      openapi: {
        method: "POST",
        path: "/check-cache",
        description: "DEPRECATED: we no longer support prompt caching.",
        protect: true,
        deprecated: true,
      },
    })
    .input(
      z.object({
        requestedAt: z.number().describe("Unix timestamp in milliseconds"),
        reqPayload: z.unknown().describe("JSON-encoded request payload"),
        tags: z
          .record(z.string())
          .optional()
          .describe(
            'Extra tags to attach to the call for filtering. Eg { "userId": "123", "promptId": "populate-title" }',
          )
          .default({}),
      }),
    )
    .output(
      z.object({
        respPayload: z.unknown().optional().describe("JSON-encoded response payload"),
      }),
    )
    .mutation(({ input, ctx }) => {
      // Return null
      return { respPayload: null };
    }),

  createChatCompletion: openApiProtectedProc
    .meta({
      openapi: {
        method: "POST",
        path: "/chat/completions",
        description: "Create completion for a prompt",
        protect: true,
      },
    })
    .input(
      // TODO: replace this whole mess with just `chatCompletionInput` once
      // no one is using the `reqPayload` field anymore.
      z.object({
        reqPayload: chatCompletionInputReqPayload
          .optional()
          .describe("DEPRECATED. Use the top-level fields instead"),
        model: z.string().optional(),
        messages: z.array(chatMessage).optional(),
        function_call: functionCallInput,
        functions: functionsInput,
        tool_choice: toolChoiceInput,
        tools: toolsInput,
        n: z.number().nullable().optional(),
        max_tokens: z.number().nullable().optional(),
        temperature: z.number().nullable().optional(),
        stream: z.boolean().default(false),
        response_format: z
          .object({
            type: z.union([z.literal("text"), z.literal("json_object")]).optional(),
          })
          .optional(),
      }),
    )
    .output(z.union([chatCompletionOutput.nullable(), z.any()]))
    .mutation(async ({ input, ctx }): Promise<ChatCompletion | ReadableStream> => {
      const { key } = ctx;

      const inputPayload =
        "reqPayload" in input
          ? chatCompletionInputReqPayload.parse(input.reqPayload)
          : chatCompletionInputReqPayload.parse(input);

      const requestedAt = Date.now();

      const isFineTune = inputPayload.model.startsWith("openpipe:");

      // Default to true if not using a fine-tuned model
      const logRequest =
        (ctx.headers["op-log-request"] === "true" || !isFineTune) &&
        ctx.headers["op-log-request"] !== "false" &&
        !ctx.key.readOnly;

      let tags: Record<string, string> = {};

      try {
        if (ctx.headers["op-tags"]) {
          try {
            const jsonTags = JSON.parse(ctx.headers["op-tags"] as string);
            tags = parseTags(jsonTags);
          } catch (error: unknown) {
            throw new TRPCError({
              message: `Failed to parse tags: ${(error as Error).message}`,
              code: "BAD_REQUEST",
            });
          }
        }

        let completion: ChatCompletion | Stream<ChatCompletionChunk> | undefined = undefined;
        let fineTune: FineTune | undefined = undefined;

        if (isFineTune) {
          const modelSlug = inputPayload.model.replace("openpipe:", "");
          fineTune =
            (await prisma.fineTune.findUnique({
              where: { slug: modelSlug },
            })) ?? undefined;

          if (!fineTune) {
            throw new TRPCError({
              message: `The model \`${inputPayload.model}\` does not exist`,
              code: "NOT_FOUND",
            });
          }

          const typedFT = typedFineTune(fineTune);

          if (typedFT && typedFT.projectId !== key.projectId) {
            throw new TRPCError({
              message: "The model does not belong to this project",
              code: "FORBIDDEN",
            });
          }

          try {
            completion = await getCompletion2(typedFT, inputPayload);
          } catch (error: unknown) {
            console.error(error);
            throw new TRPCError({
              message: `Failed to get fine-tune completion: ${(error as Error).message}`,
              code: "BAD_REQUEST",
            });
          }
        } else {
          try {
            completion = await getOpenaiCompletion(key.projectId, {
              ...inputPayload,
              stream: input.stream,
            });
          } catch (error: unknown) {
            if (error instanceof APIError) {
              // Pass through OpenAI API errors
              throw new TRPCError({
                message: error.message,
                code: trpcCodeFromHttpStatus(error.status),
              });
            }
            throw new TRPCError({
              message: `Failed to get OpenAI completion: ${(error as Error).message}`,
              code: "BAD_REQUEST",
              cause: error as Error,
            });
          }
        }

        if (completion instanceof Stream) {
          // split stream to avoid locking the read mutex
          const [recordStream, outputStream] = completion.tee();
          void recordUsage({
            projectId: key.projectId,
            requestedAt,
            receivedAt: Date.now(),
            inputPayload,
            completion: recordStream,
            logRequest,
            fineTune,
            tags,
          }).catch((e) => captureException(e));
          return outputStream.toReadableStream();
        } else {
          void recordUsage({
            projectId: key.projectId,
            requestedAt,
            receivedAt: Date.now(),
            inputPayload,
            completion,
            logRequest,
            fineTune,
            tags,
          }).catch((e) => captureException(e));
          return completion;
        }
      } catch (error: unknown) {
        if (error instanceof TRPCError) {
          const statusCode = statusCodeFromTrpcCode(error.code);
          // record error in request log
          void recordLoggedCall({
            projectId: key.projectId,
            requestedAt,
            receivedAt: Date.now(),
            reqPayload: inputPayload,
            respPayload: {
              code: error.code,
              message: error.message,
            },
            statusCode,
            errorMessage: error.message,
            tags,
          });
          throw new ExtendedTRPCError({
            code: error.code,
            message: error.message,
            extraFields: {
              // Add error field for compatibility with the OpenAI TypeScript client
              error: {
                code: statusCode,
                message: error.message,
              },
            },
          });
        }
        throw error;
      }
    }),

  report: openApiProtectedProc
    .meta({
      openapi: {
        method: "POST",
        path: "/report",
        description: "Report an API call",
        protect: true,
      },
    })
    .input(
      z.object({
        requestedAt: z.number().optional().describe("Unix timestamp in milliseconds"),
        receivedAt: z.number().optional().describe("Unix timestamp in milliseconds"),
        reqPayload: z.unknown().describe("JSON-encoded request payload"),
        respPayload: z.unknown().optional().describe("JSON-encoded response payload"),
        statusCode: z.number().optional().describe("HTTP status code of response"),
        errorMessage: z.string().optional().describe("User-friendly error message"),
        tags: z
          .record(z.union([z.string(), z.number(), z.boolean(), z.null()]))
          .optional()
          .describe(
            'Extra tags to attach to the call for filtering. Eg { "userId": "123", "promptId": "populate-title" }',
          )
          .default({}),
      }),
    )
    .output(z.object({ status: z.union([z.literal("ok"), z.literal("error")]) }))
    .mutation(async ({ input, ctx }) => {
      if (ctx.key.readOnly) {
        throw new TRPCError({
          message: "Read-only API keys cannot report API calls",
          code: "FORBIDDEN",
        });
      }
      // Zod default messes up the generated OpenAPI spec, so we do it manually
      if (!input.requestedAt) input.requestedAt = Date.now();

      const reqPayload = await reqValidator.spa(input.reqPayload);
      const respPayload = await chatCompletionOutput.spa(input.respPayload);

      let usage: CalculatedUsage | undefined;

      if (reqPayload.success && respPayload.success) {
        const fineTune = await prisma.fineTune.findUnique({
          where: { slug: reqPayload.data.model.replace("openpipe:", "") },
        });

        usage = calculateUsage({
          inputPayload: reqPayload.data,
          completion: respPayload.data,
          fineTune: fineTune ?? undefined,
        });
      }

      let tags: Record<string, string> = {};
      try {
        tags = parseTags(input.tags);
      } catch (e) {
        throw new TRPCError({
          message: `Failed to parse tags: ${(e as Error).message}`,
          code: "BAD_REQUEST",
        });
      }

      try {
        await recordLoggedCall({
          projectId: ctx.key.projectId,
          usage,
          requestedAt: input.requestedAt,
          receivedAt: input.receivedAt,
          reqPayload: input.reqPayload,
          respPayload: input.respPayload,
          statusCode: input.statusCode,
          errorMessage: input.errorMessage,
          tags,
        });
      } catch (e) {
        throw new TRPCError({
          message: `Failed to create logged call: ${(e as Error).message}`,
          code: "BAD_REQUEST",
        });
      }

      return { status: "ok" };
    }),
  localTestingOnlyGetLatestLoggedCall: openApiProtectedProc
    .meta({
      openapi: {
        method: "GET",
        path: "/local-testing-only-get-latest-logged-call",
        description: "Get the latest logged call (only for local testing)",
        protect: true, // Make sure to protect this endpoint
      },
    })
    .input(z.void())
    .output(
      z
        .object({
          createdAt: z.date(),
          statusCode: z.number().nullable(),
          errorMessage: z.string().nullable(),
          reqPayload: z.unknown(),
          respPayload: z.unknown(),
          tags: z.record(z.string().nullable()),
        })
        .nullable(),
    )
    .mutation(async ({ ctx }) => {
      if (process.env.NODE_ENV === "production") {
        throw new Error("This operation is not allowed in production environment");
      }

      const latestLoggedCall = await prisma.loggedCall.findFirst({
        where: { projectId: ctx.key.projectId },
        orderBy: { requestedAt: "desc" },
        select: {
          createdAt: true,
          tags: true,
          id: true,
          statusCode: true,
          errorMessage: true,
          reqPayload: true,
          respPayload: true,
        },
      });

      return (
        latestLoggedCall && {
          ...latestLoggedCall,
          tags: Object.fromEntries(latestLoggedCall.tags.map((tag) => [tag.name, tag.value])),
        }
      );
    }),
});
