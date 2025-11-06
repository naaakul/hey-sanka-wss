import JSZip from "jszip";

export default async (
  files: { path: string; content: string; encoding?: string }[]
) => {
  const zip = new JSZip();
  for (const file of files) {
    if (file.encoding === "base64") {
      zip.file(file.path, Buffer.from(file.content, "base64"));
    } else {
      zip.file(file.path, file.content);
    }
  }
  const zipBuffer = await zip.generateAsync({ type: "nodebuffer" });
  return zipBuffer;
};
