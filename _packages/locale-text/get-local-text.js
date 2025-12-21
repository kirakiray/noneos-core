let defaultLang = "en";

// 根据本地语言，进行修正
if (navigator.language.toLowerCase().includes("zh")) {
  defaultLang = "cn";
} else if (navigator.language.toLowerCase().includes("ja")) {
  defaultLang = "ja";
}

export const getLang = () => {
  return defaultLang;
};

export const getLocaleText = (obj) => {
  let text = obj[defaultLang] ? obj[defaultLang].textContent : "";
  // 如果没有对应语言的文本，查找en
  if (text === undefined && obj.en !== undefined) {
    text = obj.en.textContent;
  }

  // 如果没有en，返回第一个文本
  if (text === undefined) {
    text = obj[Object.keys(obj)[0]].textContent;
  }
  return text;
};

export default getLocaleText;
