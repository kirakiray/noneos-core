// Rust 学习案例 8: 生命周期（Lifetimes）
// 生命周期确保引用在使用期间始终有效

fn main() {
    // 生命周期注解语法
    let string1 = String::from("abcd");
    let string2 = "xyz";

    let result = longest(string1.as_str(), string2);
    println!("最长的字符串是 {}", result);

    // 结构体中的生命周期
    let novel = String::from("Call me Ishmael. Some years ago...");
    let first_sentence = novel.split('.').next().expect("Could not find a '.'");
    let i = ImportantExcerpt {
        part: first_sentence,
    };
    println!("重要摘录: {}", i.part);

    // 生命周期省略
    let s = "hello";
    let len = first_word(s);
    println!("第一个单词长度: {}", len);

    // 静态生命周期
    let s: &'static str = "我有静态生命周期";
    println!("{}", s);
}

// 生命周期注解
fn longest<'a>(x: &'a str, y: &'a str) -> &'a str {
    if x.len() > y.len() {
        x
    } else {
        y
    }
}

// 结构体中的生命周期
struct ImportantExcerpt<'a> {
    part: &'a str,
}

// 生命周期省略规则
// 1. 每一个是引用的参数都有它自己的生命周期参数
// 2. 如果只有一个输入生命周期参数，那么它被赋予所有输出生命周期参数
// 3. 如果方法有多个输入生命周期参数，不过其中之一是 &self 或 &mut self，
//    那么所有输出生命周期参数被赋予 self 的生命周期

// 生命周期省略的例子
fn first_word(s: &str) -> &str {
    let bytes = s.as_bytes();

    for (i, &item) in bytes.iter().enumerate() {
        if item == b' ' {
            return &s[0..i];
        }
    }

    &s[..]
}

// 结合泛型、trait bounds 和生命周期
fn longest_with_an_announcement<'a, T>(
    x: &'a str,
    y: &'a str,
    ann: T,
) -> &'a str
where
    T: std::fmt::Display,
{
    println!("公告: {}", ann);
    if x.len() > y.len() {
        x
    } else {
        y
    }
}