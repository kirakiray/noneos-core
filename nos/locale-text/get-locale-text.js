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

// 通过对象获取对应语言的文本
export const getLocaleText = (obj) => {
  if (obj == null || typeof obj !== "object") {
    return undefined;
  }

  let text = obj[getLang()];

  // 如果没有对应语言的文本，查找 en
  if (text === undefined && obj.en !== undefined) {
    text = obj.en;
  }

  // 如果没有 en，返回第一个文本
  if (text === undefined) {
    const firstKey = Object.keys(obj)[0];
    if (firstKey !== undefined) {
      text = obj[firstKey];
    }
  }

  return text;
};

export default getLocaleText;
