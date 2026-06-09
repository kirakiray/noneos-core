// Rust 学习案例 6: 所有权（Ownership）
// 所有权是 Rust 最独特的特性，它让 Rust 无需垃圾回收器即可保证内存安全

fn main() {
    // 所有权规则：
    // 1. Rust 中的每一个值都有一个被称为其所有者（owner）的变量
    // 2. 值在任一时刻有且只有一个所有者
    // 3. 当所有者（变量）离开作用域，这个值将被丢弃

    // 变量作用域
    {
        let s = "hello";  // s 在此处有效
        println!("{}", s);
    } // 此作用域结束，s 不再有效

    // String 类型（堆分配）
    let mut s = String::from("hello");
    s.push_str(", world!");  // push_str() 在字符串后追加字面值
    println!("{}", s);

    // 移动（Move）
    let s1 = String::from("hello");
    let s2 = s1;  // s1 被移动到 s2，s1 不再有效
    // println!("{}", s1);  // 错误！s1 已经失效
    println!("s2 = {}", s2);

    // 克隆（Clone）
    let s3 = String::from("hello");
    let s4 = s3.clone();  // 深拷贝
    println!("s3 = {}, s4 = {}", s3, s4);  // 两者都有效

    // 栈上的数据：拷贝
    let x = 5;
    let y = x;  // 整数是 Copy 类型，不会移动
    println!("x = {}, y = {}", x, y);

    // 所有权与函数
    let s = String::from("hello");
    takes_ownership(s);  // s 的值移动到函数里
    // println!("{}", s);  // 错误！s 已经失效

    let x = 5;
    makes_copy(x);  // i32 是 Copy 类型，所以可以继续使用
    println!("x 仍然有效: {}", x);

    // 返回值与所有权
    let s1 = gives_ownership();  // 函数将所有权转移给 s1
    println!("s1 = {}", s1);

    let s2 = String::from("hello");
    let s3 = takes_and_gives_back(s2);  // s2 被移动到函数，函数返回值移动给 s3
    println!("s3 = {}", s3);
}

fn takes_ownership(some_string: String) {
    println!("函数获得所有权: {}", some_string);
} // some_string 离开作用域并调用 `drop`，内存被释放

fn makes_copy(some_integer: i32) {
    println!("函数获得拷贝: {}", some_integer);
} // some_integer 离开作用域，但因为是 Copy 类型，没有特殊操作

fn gives_ownership() -> String {
    let some_string = String::from("yours");
    some_string  // 返回值移动给调用函数
}

fn takes_and_gives_back(a_string: String) -> String {
    a_string  // a_string 被返回并移动给调用函数
}