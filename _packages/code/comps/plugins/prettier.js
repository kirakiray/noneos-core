export default async ({ monaco, editor }) => {
  // 注册格式化提供者
  monaco.languages.registerDocumentFormattingEditProvider(
    [
      "javascript",
      "typescript",
      "html",
      "css",
      "json",
      "markdown",
      "yaml",
      "graphql",
    ],
    {
      async provideDocumentFormattingEdits(model) {
        const language = model.getLanguageId();

        try {
          const { prettier, plugins } = await loadPrettierAndPlugins(language);

          // 映射 Monaco 语言到 Prettier parser
          const parserMap = {
            javascript: "babel",
            typescript: "typescript",
            html: "html",
            css: "css",
            json: "json",
            markdown: "markdown",
            yaml: "yaml",
            graphql: "graphql",
          };

          const formatted = await prettier.format(model.getValue(), {
            parser: parserMap[language],
            plugins,
            tabWidth: 2,
            semi: true,
            singleQuote: true,
            printWidth: 80,
          });

          // 返回格式化后的文本范围
          return [
            {
              range: model.getFullModelRange(),
              text: formatted,
            },
          ];
        } catch (error) {
          console.error("格式化失败:", error);
          return []; // 返回空数组表示格式化失败
        }
      },
    }
  );
};

// 动态加载 Prettier 和插件（按需加载）
async function loadPrettierAndPlugins(language) {
  const prettier = await import("/npm/prettier@3.4.1/standalone.mjs");

  // 根据语言加载必要插件
  const plugins = [];

  // JS/TS/JSON 必须加载 estree
  if (["javascript", "typescript", "json", "html"].includes(language)) {
    const estree = await import("/npm/prettier@3.4.1/plugins/estree.mjs");
    plugins.push(estree);
  }

  if (["html", "htm"].includes(language)) {
    const babel = await import("/npm/prettier@3.4.1/plugins/babel.mjs");
    plugins.push(babel);
  }

  switch (language) {
    case "javascript":
      const babel = await import("/npm/prettier@3.4.1/plugins/babel.mjs");
      plugins.push(babel);
      break;
    case "typescript":
      const typescript = await import(
        "/npm/prettier@3.4.1/plugins/typescript.mjs"
      );
      plugins.push(typescript);
      break;
    case "html": {
      const html = await import("/npm/prettier@3.4.1/plugins/html.mjs");
      plugins.push(html);
      break;
    }
    case "css":
      const postcss = await import("/npm/prettier@3.4.1/plugins/postcss.mjs");
      plugins.push(postcss);
      break;
    case "json":
      const babelForJson = await import(
        "/npm/prettier@3.4.1/plugins/babel.mjs"
      );
      plugins.push(babelForJson);
      break;
    case "markdown":
      const markdown = await import("/npm/prettier@3.4.1/plugins/markdown.mjs");
      plugins.push(markdown);
      break;
    case "yaml":
      const yaml = await import("/npm/prettier@3.4.1/plugins/yaml.mjs");
      plugins.push(yaml);
      break;
    case "graphql":
      const graphql = await import("/npm/prettier@3.4.1/plugins/graphql.mjs");
      plugins.push(graphql);
      break;
  }

  return { prettier, plugins };
}
