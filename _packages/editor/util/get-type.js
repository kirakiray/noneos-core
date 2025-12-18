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
  } else if (ext === "ts") {
    return "typescript";
  } else if (ext === "jsx") {
    return "javascriptreact";
  } else if (ext === "tsx") {
    return "typescriptreact";
  } else if (
    ext === "css" ||
    ext === "scss" ||
    ext === "sass" ||
    ext === "less"
  ) {
    return "css";
  } else if (ext === "html" || ext === "htm") {
    return "html";
  } else if (ext === "json") {
    return "json";
  } else if (ext === "md" || ext === "markdown") {
    return "markdown";
  } else if (ext === "xml") {
    return "xml";
  } else if (ext === "py") {
    return "python";
  } else if (ext === "java") {
    return "java";
  } else if (
    ext === "cpp" ||
    ext === "cxx" ||
    ext === "cc" ||
    ext === "hpp" ||
    ext === "hxx" ||
    ext === "hh"
  ) {
    return "cpp";
  } else if (ext === "c" || ext === "h") {
    return "c";
  } else if (ext === "cs") {
    return "csharp";
  } else if (ext === "go") {
    return "go";
  } else if (ext === "php") {
    return "php";
  } else if (ext === "rb") {
    return "ruby";
  } else if (ext === "swift") {
    return "swift";
  } else if (ext === "kt" || ext === "kts") {
    return "kotlin";
  } else if (ext === "rs") {
    return "rust";
  } else if (ext === "sql") {
    return "sql";
  } else if (ext === "yaml" || ext === "yml") {
    return "yaml";
  } else if (ext === "sh" || ext === "bash") {
    return "shellscript";
  } else {
    return "text";
  }
};
