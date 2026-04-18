现在请你帮忙补充 docs/cn/documentation/ai-add.md 和 docs/cn/documentation/ai-call.md。关键点如下。

**ai-add.md**
- 在已经部署过的系统内，基于系统开发的应用，可以通过使用 `o-page` 引用 `https://core.noneos.com/nos-tool/ai/pages/key-manager.html` 来加入添加ai模型的入口。
- 如果 `useNosTool` 的模式已经开启，则可以直接使用 `/nos-tool/ai/pages/key-manager.html`；
```html
 <o-page src="/nos-tool/ai/pages/key-manager.html"></o-page>
```
- 这样就可以在你的 ofa.js应用中，直接加入添加ai模型的入口了。
- 使用模型则通过 `import { chat } from "/nos/ai/chat.js"` 来引入。
- 具体使用方法在 nos/ai/chat.js 中。
