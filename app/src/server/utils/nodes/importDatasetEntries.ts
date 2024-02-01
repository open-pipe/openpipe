import { type Prisma } from "@prisma/client";

import { prisma } from "~/server/db";
import { downloadBlobToStrings } from "~/utils/azure/server";
import {
  isParseError,
  isRowToImport,
  parseRowsToImport,
} from "~/components/datasets/parseRowsToImport";
import { prepareDatasetEntriesForImport } from "../datasetEntryCreation/prepareDatasetEntriesForImport";
import { countDatasetEntryTokens } from "~/server/tasks/fineTuning/countDatasetEntryTokens.task";
import { generateImportId } from "./importId";

export const importDatasetEntries = async ({
  projectId,
  nodeId,
  dataChannelId,
  datasetFileUploadId,
  maxEntriesToImport,
}: {
  projectId: string;
  nodeId: string;
  dataChannelId: string;
  datasetFileUploadId: string;
  maxEntriesToImport: number;
}) => {
  const datasetFileUpload = await prisma.datasetFileUpload.findUnique({
    where: { id: datasetFileUploadId },
  });

  const updateDatasetFileUpload = async (data: Prisma.DatasetFileUploadUpdateInput) =>
    prisma.datasetFileUpload.update({
      where: { id: datasetFileUploadId },
      data,
    });

  if (!datasetFileUpload) {
    await updateDatasetFileUpload({
      errorMessage: "Dataset File Upload not found",
      status: "ERROR",
    });
    return;
  }
  await updateDatasetFileUpload({
    status: "DOWNLOADING",
    progress: 5,
  });

  const onBlobDownloadProgress = async (progress: number) => {
    await updateDatasetFileUpload({
      progress: 5 + Math.floor((progress / datasetFileUpload.fileSize) * 60),
    });
  };

  const rawRows = await downloadBlobToStrings({
    blobName: datasetFileUpload.blobName,
    // account for up to 50% errored lines
    maxEntriesToImport: maxEntriesToImport * 2,
    onProgress: onBlobDownloadProgress,
  });

  const rowsToImport = parseRowsToImport(rawRows);

  const errorRows = rowsToImport.filter(isParseError);
  const goodRows = rowsToImport.filter(isRowToImport);

  if (!goodRows.length || errorRows.length > goodRows.length) {
    const error = errorRows[0]?.error ?? "No lines to import";
    const line = errorRows[0]?.line ?? 0;

    await prisma.datasetFileUpload.update({
      where: { id: datasetFileUploadId },
      data: {
        errorMessage: `Invalid JSONL on line ${line}: ${error}`,
        status: "ERROR",
      },
    });
  }

  await updateDatasetFileUpload({
    status: "PROCESSING",
    progress: 60,
  });

  const importTime = new Date().toISOString();

  const entriesToImport = goodRows.slice(0, maxEntriesToImport).map((row, index) => ({
    ...row,
    importId: generateImportId({
      uniquePrefix: `${importTime}-${index}`,
      nodeId,
    }),
  }));

  let datasetEntryInputsToCreate: Prisma.DatasetEntryInputCreateManyInput[];
  let datasetEntryOutputsToCreate: Prisma.DatasetEntryOutputCreateManyInput[];
  let nodeDataToCreate: Prisma.NodeDataCreateManyInput[];
  try {
    ({ datasetEntryInputsToCreate, datasetEntryOutputsToCreate, nodeDataToCreate } =
      prepareDatasetEntriesForImport({
        projectId,
        nodeId,
        dataChannelId,
        entriesToImport,
      }));
  } catch (e: unknown) {
    await updateDatasetFileUpload({
      errorMessage: `Error preparing rows: ${(e as Error).message}`,
      status: "ERROR",
      visible: true,
    });
    return;
  }

  await updateDatasetFileUpload({
    status: "SAVING",
    progress: 70,
  });

  // save datasetEntryInputs in batches of 1000
  for (let i = 0; i < datasetEntryInputsToCreate.length; i += 1000) {
    const chunk = datasetEntryInputsToCreate.slice(i, i + 1000);
    await prisma.datasetEntryInput.createMany({
      data: chunk,
      skipDuplicates: true,
    });
    await updateDatasetFileUpload({
      progress: 70 + Math.floor(10 * (i / datasetEntryInputsToCreate.length)),
    });
  }

  // save datasetEntryOutputs in batches of 1000
  for (let i = 0; i < datasetEntryOutputsToCreate.length; i += 1000) {
    const chunk = datasetEntryOutputsToCreate.slice(i, i + 1000);
    await prisma.datasetEntryOutput.createMany({
      data: chunk,
      skipDuplicates: true,
    });
    await updateDatasetFileUpload({
      progress: 80 + Math.floor(10 * (i / datasetEntryOutputsToCreate.length)),
    });
  }

  // save nodeData in batches of 1000
  for (let i = 0; i < nodeDataToCreate.length; i += 1000) {
    const chunk = nodeDataToCreate.slice(i, i + 1000);
    await prisma.nodeData.createMany({
      data: chunk,
      skipDuplicates: true,
    });
    await updateDatasetFileUpload({
      progress: 90 + Math.floor(5 * (i / nodeDataToCreate.length)),
    });
  }

  await updateDatasetFileUpload({ progress: 95 });

  await updateDatasetFileUpload({ progress: 99 });

  await countDatasetEntryTokens.enqueue();

  await updateDatasetFileUpload({
    status: "COMPLETE",
    progress: 100,
    visible: true,
  });
};
