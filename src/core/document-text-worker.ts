import { parentPort, workerData } from "node:worker_threads";
import { OfficeParser } from "officeparser";
import { errMessage } from "../util/errors.ts";

try {
  const ast = await OfficeParser.parseOffice(Buffer.from(workerData.dataBase64, "base64"), {
    ocr: false,
    extractAttachments: false,
    decompressionLimits: { maxUncompressedBytes: 32_000_000, maxZipEntries: 2000, maxTableCells: 100_000 },
  });
  const result = await ast.to("text");
  parentPort?.postMessage({ text: String(result.value) });
} catch (error) {
  parentPort?.postMessage({ error: errMessage(error) });
}
