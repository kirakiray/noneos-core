// Rust 学习案例 5: 控制流

fn main() {
    // if 表达式
    let number = 6;
    
    if number % 4 == 0 {
        println!("number 可以被 4 整除");
    } else if number % 3 == 0 {
        println!("number 可以被 3 整除");
    } else if number % 2 == 0 {
        println!("number 可以被 2 整除");
    } else {
        println!("number 不能被 4、3 或 2 整除");
    }
    
    // if 是表达式，可以用在 let 语句中
    let condition = true;
    let x = if condition { 5 } else { 6 };
    println!("x 的值是: {}", x);
    
    // 循环
    
    // loop 循环
    let mut counter = 0;
    let result = loop {
        counter += 1;
        if counter == 10 {
            break counter * 2;  // 返回值
        }
    };
    println!("loop 结果: {}", result);
    
    // while 循环
    let mut number = 3;
    while number != 0 {
        println!("倒计时: {}!", number);
        number -= 1;
    }
    println!("发射！");
    
    // for 循环
    let arr = [10, 20, 30, 40, 50];
    for element in arr.iter() {
        println!("数组元素: {}", element);
    }
    
    // Range
    for number in 1..4 {
        println!("Range: {}", number);
    }
    
    // 反向 Range
    for number in (1..4).rev() {
        println!("反向 Range: {}", number);
    }
    
    // match 表达式
    let number = 13;
    match number {
        1 => println!("一"),
        2 | 3 | 5 | 7 | 11 | 13 => println!("质数"),
        13..=19 => println!("青少年"),
        _ => println!("其他"),
    }
    
    // if let 简化 match
    let some_value = Some(3);
    if let Some(x) = some_value {
        println!("匹配到的值: {}", x);
    }
    
    // while let
    let mut optional = Some(0);
    while let Some(i) = optional {
        if i > 5 {
            println!("大于 5，退出");
            optional = None;
        } else {
            println!("i 是 {:?}", i);
            optional = Some(i + 1);
        }
    }
}