import { getFileHandle } from "./fs.js";
import { getContentType } from "./util.js";

export const getByFile = async ({ path }) => {
  const rePath = path.replace(/^\/\$/, "");

  const fileHandle = await getFileHandle({ path: rePath }).catch(() => null);

  if (fileHandle) {
    const fileStream = await fileHandle.getFile();
    if (fileStream.size) {
      return new Response(fileStream, {
        headers: {
          "Content-Type": getContentType(path),
        },
      });
    }
  }

  return new Response("Not Found", {
    status: 404,
    headers: {
      "Content-Type": getContentType(path),
    },
  });
};
