// Rust 学习案例 11: 模式匹配（Pattern Matching）

fn main() {
    // match 表达式
    let number = 13;
    println!("告诉我关于 {}", number);
    match number {
        1 => println!("一！"),
        2 | 3 | 5 | 7 => println!("这是质数"),
        13..=19 => println!("青少年"),
        _ => println!("没什么特别的"),
    }

    // 解构结构体
    struct Point {
        x: i32,
        y: i32,
    }

    let point = Point { x: 0, y: 7 };
    match point {
        Point { x, y: 0 } => println!("在 x 轴上，x = {}", x),
        Point { x: 0, y } => println!("在 y 轴上，y = {}", y),
        Point { x, y } => println!("在其他位置 ({}, {})", x, y),
    }

    // 解构枚举
    enum Color {
        Rgb(i32, i32, i32),
        Hsv(i32, i32, i32),
    }

    let color = Color::Rgb(122, 17, 40);
    match color {
        Color::Rgb(r, g, b) => {
            println!("RGB: ({}, {}, {})", r, g, b);
        }
        Color::Hsv(h, s, v) => {
            println!("HSV: ({}, {}, {})", h, s, v);
        }
    }

    // 解构元组和数组
    let tuple = (1, 2, 3);
    match tuple {
        (0, y, z) => println!("第一个是 0，y = {}, z = {}", y, z),
        (x, 0, z) => println!("第二个是 0，x = {}, z = {}", x, z),
        (x, y, 0) => println!("第三个是 0，x = {}, y = {}", x, y),
        _ => println!("没有 0"),
    }

    let array = [1, 2, 3];
    match array {
        [0, second, third] => println!("第一个是 0，{}, {}", second, third),
        [first, 0, third] => println!("第二个是 0，{}, {}", first, third),
        [first, second, 0] => println!("第三个是 0，{}, {}", first, second),
        _ => println!("没有 0"),
    }

    // 忽略值
    let numbers = (2, 4, 8, 16, 32);
    match numbers {
        (first, _, third, _, fifth) => {
            println!("某些数字: {}, {}, {}", first, third, fifth);
        }
    }

    // 绑定值
    let age = 15;
    match age {
        n @ 13..=19 => println!("青少年，年龄是 {}", n),
        n => println!("不是青少年，年龄是 {}", n),
    }

    // 条件守卫
    let num = Some(4);
    match num {
        Some(x) if x < 5 => println!("小于 5: {}", x),
        Some(x) => println!("{}", x),
        None => (),
    }

    // if let
    let some_value = Some(3);
    if let Some(x) = some_value {
        println!("匹配到: {}", x);
    }

    // while let
    let mut stack = Vec::new();
    stack.push(1);
    stack.push(2);
    stack.push(3);

    while let Some(top) = stack.pop() {
        println!("栈顶: {}", top);
    }

    // let 模式
    let (x, y, z) = (1, 2, 3);
    println!("x = {}, y = {}, z = {}", x, y, z);

    // 函数参数模式
    fn print_coordinates(&(x, y): &(i32, i32)) {
        println!("当前位置: ({}, {})", x, y);
    }
    let point = (3, 5);
    print_coordinates(&point);

    // 范围匹配
    let x = 5;
    match x {
        1..=5 => println!("一到五"),
        _ => println!("其他"),
    }
}