# Rust 学习案例

这个项目包含了一系列 Rust 学习案例，涵盖了从基础到高级的 Rust 编程概念。

## 项目结构

```
study-rust/
├── Cargo.toml
├── README.md
└── src/
    ├── 01_basics/           # 基础语法
    │   ├── hello_world.rs   # Hello World
    │   ├── variables.rs      # 变量和可变性
    │   ├── data_types.rs     # 数据类型
    │   ├── functions.rs      # 函数
    │   └── control_flow.rs   # 控制流
    ├── 02_ownership/         # 所有权系统
    │   ├── ownership.rs      # 所有权
    │   ├── borrowing.rs      # 引用与借用
    │   └── lifetimes.rs      # 生命周期
    ├── 03_structs_enums/     # 结构体和枚举
    │   ├── structs.rs        # 结构体
    │   ├── enums.rs          # 枚举
    │   └── pattern_matching.rs # 模式匹配
    ├── 04_error_handling/    # 错误处理
    │   ├── error_handling.rs # 错误处理基础
    │   └── custom_errors.rs  # 自定义错误类型
    └── 05_concurrency/       # 并发编程
        ├── concurrency.rs    # 线程和消息传递
        └── async_await.rs    # 异步编程
```

## 运行示例

### 运行单个示例

```bash
# 运行 Hello World
cargo run --bin hello_world

# 运行变量示例
cargo run --bin variables

# 运行所有权示例
cargo run --bin ownership

# 运行结构体示例
cargo run --bin structs

# 运行错误处理示例
cargo run --bin error_handling

# 运行并发示例
cargo run --bin concurrency

# 运行异步示例
cargo run --bin async_await
```

### 运行所有示例

```bash
# 编译所有示例
cargo build

# 检查代码
cargo check
```

## 学习路径

### 1. 基础语法（01_basics）
- **hello_world.rs**: 学习 Rust 的基本输出和格式化
- **variables.rs**: 理解变量、可变性和常量
- **data_types.rs**: 掌握 Rust 的数据类型系统
- **functions.rs**: 学习函数定义和参数传递
- **control_flow.rs**: 掌握条件判断和循环

### 2. 所有权系统（02_ownership）
- **ownership.rs**: 理解 Rust 的核心概念 - 所有权
- **borrowing.rs**: 学习引用和借用规则
- **lifetimes.rs**: 掌握生命周期注解

### 3. 结构体和枚举（03_structs_enums）
- **structs.rs**: 学习结构体的定义和方法
- **enums.rs**: 掌握枚举和 Option 类型
- **pattern_matching.rs**: 学习强大的模式匹配

### 4. 错误处理（04_error_handling）
- **error_handling.rs**: 理解 panic 和 Result
- **custom_errors.rs**: 学习自定义错误类型

### 5. 并发编程（05_concurrency）
- **concurrency.rs**: 学习线程、消息传递和共享状态
- **async_await.rs**: 掌握异步编程

## 依赖项

- **tokio**: 异步运行时（用于异步编程示例）

## 学习建议

1. 按照顺序学习，从基础语法开始
2. 每个示例都包含详细注释，建议仔细阅读
3. 尝试修改示例代码，观察编译器的行为
4. 遇到编译错误时，仔细阅读错误信息，Rust 编译器会提供有用的建议
5. 使用 `cargo check` 快速检查代码而不生成可执行文件

## 常用命令

```bash
# 创建新项目
cargo new project_name

# 编译项目
cargo build

# 运行项目
cargo run

# 检查代码（更快）
cargo check

# 运行测试
cargo test

# 生成文档
cargo doc --open

# 格式化代码
cargo fmt

# 代码检查
cargo clippy
```

## 资源

- [Rust 官方网站](https://www.rust-lang.org/)
- [Rust 官方文档](https://doc.rust-lang.org/)
- [Rust 程序设计语言（The Book）](https://doc.rust-lang.org/book/)
- [Rust by Example](https://doc.rust-lang.org/rust-by-example/)
- [Rust 标准库文档](https://doc.rust-lang.org/std/)

## 许可证

MIT License