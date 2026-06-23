// Rust 学习案例 9: 结构体（Structs）

// 定义结构体
struct User {
    username: String,
    email: String,
    active: bool,
    sign_in_count: u64,
}

// 元组结构体
struct Color(i32, i32, i32);
struct Point(i32, i32, i32);

// 单元结构体
struct AlwaysEqual;

// 为结构体实现方法
impl User {
    // 关联函数（构造函数）
    fn new(username: String, email: String) -> User {
        User {
            username,
            email,
            active: true,
            sign_in_count: 1,
        }
    }

    // 方法
    fn is_active(&self) -> bool {
        self.active
    }

    // 可变方法
    fn deactivate(&mut self) {
        self.active = false;
    }

    // 关联函数（不是方法）
    fn from(email: String, username: String) -> User {
        User {
            username,
            email,
            active: true,
            sign_in_count: 1,
        }
    }
}

fn main() {
    // 创建结构体实例
    let user1 = User {
        email: String::from("user@example.com"),
        username: String::from("user123"),
        active: true,
        sign_in_count: 1,
    };

    println!("用户名: {}", user1.username);
    println!("邮箱: {}", user1.email);

    // 可变结构体
    let mut user2 = User {
        email: String::from("user2@example.com"),
        username: String::from("user456"),
        active: true,
        sign_in_count: 1,
    };

    user2.email = String::from("newemail@example.com");
    println!("新邮箱: {}", user2.email);

    // 结构体更新语法
    let user3 = User {
        email: String::from("user3@example.com"),
        ..user1  // 其余字段来自 user1
    };
    println!("user3 用户名: {}", user3.username);

    // 使用关联函数创建实例
    let user4 = User::new(
        String::from("user4"),
        String::from("user4@example.com"),
    );
    println!("user4: {}", user4.username);

    // 调用方法
    println!("user4 是否活跃: {}", user4.is_active());

    // 元组结构体
    let black = Color(0, 0, 0);
    let origin = Point(0, 0, 0);
    println!("黑色: ({}, {}, {})", black.0, black.1, black.2);
    println!("原点: ({}, {}, {})", origin.0, origin.1, origin.2);

    // 单元结构体
    let subject = AlwaysEqual;
    // 单元结构体不存储任何数据

    // 打印结构体
    #[derive(Debug)]
    struct Rectangle {
        width: u32,
        height: u32,
    }

    let rect = Rectangle {
        width: 30,
        height: 50,
    };

    println!("rect: {:?}", rect);  // 调试输出
    println!("rect: {:#?}", rect); // 美化调试输出
}