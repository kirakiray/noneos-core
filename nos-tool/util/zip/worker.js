// import JSZip from "https://cdn.jsdelivr.net/npm/jszip@3.10.1/+esm";
// import JSZip from "./jszip.js";
import JSZip from "/npm/jszip@3.10.1/+esm";

const zips = new Map();

self.onmessage = async ({ data }) => {
  if (data.taskType === "unzip") {
    await handleUnzip(data);
  } else {
    handlePack(data);
  }
};

const handleUnzip = async ({ id, file }) => {
  try {
    const content = await unzipFile(file);
    self.postMessage({ id, content });
  } catch (err) {
    self.postMessage({ id, error: err.toString() });
  }
};

const handlePack = ({ id, path, file, isEnd }) => {
  const zip = zips.get(id) || new JSZip();
  zip.file(path, file);
  zips.set(id, zip);

  if (isEnd) {
    zip.generateAsync({ type: "blob" }).then((content) => {
      self.postMessage({ id, content });
      zips.delete(id);
    });
  }
};

const unzipFile = (file) =>
  new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = async ({ target: { result } }) => {
      try {
        const zip = await JSZip.loadAsync(result);
        const tasks = [];

        for (const [name, zipEntry] of Object.entries(zip.files)) {
          const entryName = name.split("/").pop();
          if (entryName && entryName !== ".DS_Store") {
            const content = await zipEntry.async("blob");
            tasks.push({ path: name, file: new File([content], entryName) });
          }
        }

        resolve(tasks);
      } catch (err) {
        reject(err);
      }
    };
    reader.onerror = reject;
    reader.readAsArrayBuffer(file);
  });
