// 从 storage 中读取显式指定的语言（sessionStorage 优先于 localStorage）
let storedLang = sessionStorage.getItem("lang") || localStorage.getItem("lang");

if (!storedLang) {
  // 根据浏览器语言推断，使用 BCP 47 主子标签进行匹配
  const navLang = navigator.language.toLowerCase();
  const primary = navLang.split("-")[0];
  if (primary === "zh") {
    // 暂不区分 zh-cn / zh-tw / zh-hk，统一归为 cn
    storedLang = "cn";
  } else if (primary === "ja") {
    storedLang = "ja";
  } else if (primary === "en") {
    storedLang = "en";
  }
}

if (!storedLang) {
  storedLang = "en";
}

// 当前生效的语言，运行时可通过 setLang 修改
let currentLang = storedLang;

export const getLang = () => currentLang;

// 运行时切换语言（传 falsy 值则恢复到 storage 中的设定）
export const setLang = (lang) => {
  if (!lang) {
    currentLang = storedLang;
  } else {
    currentLang = lang;
  }
  // 通知所有 <locale-text> 组件刷新
  if (typeof window !== "undefined" && window.dispatchEvent) {
    window.dispatchEvent(new CustomEvent("locale-text:lang-change"));
  }
};

// locale-text.json 的模块级缓存（同一页面只 fetch 一次）
let _jsonPromise = null;

// 获取中央翻译表（命中缓存后不再重复请求）
export const fetchLocaleTextJson = () => {
  if (_jsonPromise) return _jsonPromise;
  _jsonPromise = fetch("/locale-text.json")
    .then((res) => (res.ok ? res.json() : null))
    .catch(() => null);
  return _jsonPromise;
};

// locale-text.json 的反向索引：baseText -> entry（同步可读）
// 预加载后 getLocaleText 可同步命中，未加载时回退到传入对象
let _jsonIndex = null;

// 提前加载 locale-text.json 并构建反向索引
export const ensureLocaleTextJson = async () => {
  if (_jsonIndex !== null) return;
  const json = (await fetchLocaleTextJson()) || {};
  _jsonIndex = {};
  for (const entry of Object.values(json)) {
    const baseText = entry.cn ?? entry.en ?? Object.values(entry)[0];
    if (baseText != null) _jsonIndex[baseText] = entry;
  }
};

// {key} 占位符替换（与 <locale-text> 组件的插值语法一致）
const interpolate = (text, vars) => {
  if (!vars) return text;
  return String(text).replace(/\{([\w-]+)\}/g, (match, key) => {
    const val = vars[key];
    return val !== undefined ? String(val) : match;
  });
};

// 通过对象获取对应语言的文本
// 查找优先级：
//   1. locale-text.json 反向索引（支持运行时扩展更多语种，需 ensureLocaleTextJson 预加载）
//   2. 回退到传入对象（lang → en → 第一个字段）
// 命中后对结果做 {key} 变量插值（vars）
export const getLocaleText = (obj, vars) => {
  if (obj == null || typeof obj !== "object") {
    return undefined;
  }

  const lang = getLang();
  let text;

  // 基准文本优先级：cn → en → 第一个字段（与工具/组件保持一致）
  const baseText = obj.cn ?? obj.en ?? Object.values(obj)[0];

  // 1. 优先查 locale-text.json 反向索引
  if (_jsonIndex && baseText != null) {
    const entry = _jsonIndex[baseText];
    if (entry && entry[lang] !== undefined) {
      text = entry[lang];
    }
  }

  // 2. 回退到传入对象
  if (text === undefined) {
    text = obj[lang];
    if (text === undefined && obj.en !== undefined) {
      text = obj.en;
    }
    if (text === undefined) {
      const firstKey = Object.keys(obj)[0];
      if (firstKey !== undefined) {
        text = obj[firstKey];
      }
    }
  }

  // 3. 变量插值
  if (vars && text != null) {
    text = interpolate(text, vars);
  }

  return text;
};

export default getLocaleText;

// 重置 JSON 缓存（主要用于测试隔离）
export const resetLocaleTextJsonCache = () => {
  _jsonPromise = null;
  _jsonIndex = null;
};

// 模块加载时即开始预加载（fire-and-forget，不阻塞）
// 未加载完成时 getLocaleText 回退到传入对象，加载完成后自动命中
ensureLocaleTextJson();
