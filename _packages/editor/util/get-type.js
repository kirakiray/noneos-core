// 获取文件类型
export const getType = (path) => {
  // 处理空路径
  if (!path) {
    return "text";
  }

  // 获取后缀
  const ext = path.split(".").pop();

  // 处理不同后缀的文件类型
  if (ext === "js" || ext === "mjs" || ext === "cjs") {
    return "javascript";
  } else if (ext === "css" || ext === "scss") {
    return "css";
  } else if (ext === "html" || ext === "htm") {
    return "html";
  } else if (ext === "json") {
    return "json";
  } else if (ext === "md") {
    return "markdown";
  } else if (ext === "xml") {
    return "xml";
  } else {
    return "text";
  }
};
