// Rust 学习案例 7: 引用与借用（Borrowing）
// 引用允许你使用值但不获取其所有权

fn main() {
    // 引用
    let s1 = String::from("hello");
    let len = calculate_length(&s1);  // 传递引用
    println!("字符串 '{}' 的长度是 {}", s1, len);

    // 可变引用
    let mut s = String::from("hello");
    change(&mut s);
    println!("修改后的字符串: {}", s);

    // 可变引用的限制：同一时间只能有一个可变引用
    let mut s = String::from("hello");
    {
        let r1 = &mut s;
        r1.push_str(" world");
    } // r1 离开作用域，可以创建新的可变引用
    let r2 = &mut s;
    r2.push_str("!");
    println!("最终字符串: {}", s);

    // 不能同时拥有可变引用和不可变引用
    let mut s = String::from("hello");
    let r1 = &s;  // 没问题
    let r2 = &s;  // 没问题
    println!("{} and {}", r1, r2);
    // r1 和 r2 在此之后不再使用
    let r3 = &mut s;  // 没问题
    r3.push_str(" world");
    println!("r3: {}", r3);

    // 悬垂引用（Rust 会阻止）
    // let reference_to_nothing = dangle();  // 错误！

    // 切片
    let s = String::from("hello world");
    let hello = &s[0..5];  // 或 &s[..5]
    let world = &s[6..11]; // 或 &s[6..]
    println!("切片: {} {}", hello, world);

    // 字符串字面量就是切片
    let s: &str = "Hello, world!";

    // 数组切片
    let a = [1, 2, 3, 4, 5];
    let slice = &a[1..3];
    println!("数组切片: {:?}", slice);
}

fn calculate_length(s: &String) -> usize {
    s.len()
} // s 离开作用域，但因为它没有所有权，所以什么也不会发生

fn change(some_string: &mut String) {
    some_string.push_str(", world");
}

// 错误示例：悬垂引用
// fn dangle() -> &String {
//     let s = String::from("hello");
//     &s  // 错误！s 在函数结束时会被释放
// }

// 正确做法：返回所有权
fn no_dangle() -> String {
    let s = String::from("hello");
    s
}