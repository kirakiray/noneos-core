# syntax=docker/dockerfile:1

# =============================================================================
# 阶段 1：编译 release 二进制
# 注意：如需在 Apple Silicon 上为 x86 服务器构建，请在 build 时指定
#       --platform=linux/amd64（不要在此硬编码，以免拖慢原生构建）
# =============================================================================
FROM rust:latest AS builder
WORKDIR /src

# 先只拷依赖清单 + 占位 main.rs 编译依赖，利用层缓存加速重复构建
COPY Cargo.toml Cargo.lock ./
RUN mkdir src && echo "fn main() {}" > src/main.rs \
    && cargo build --release \
    && rm -rf src

# 拷真实源码并编译最终二进制（依赖已缓存，仅重编项目本体）
COPY src ./src
RUN touch src/main.rs && cargo build --release

# =============================================================================
# 阶段 2：最小运行镜像
# =============================================================================
FROM debian:bookworm-slim
WORKDIR /app

# 运行所需最小依赖（ca-certificates 便于未来对接 TLS / 外部 HTTPS）
RUN apt-get update \
    && apt-get install -y --no-install-recommends ca-certificates \
    && rm -rf /var/lib/apt/lists/*

# 拷贝编译产物（注意：builder 工作目录是 /src，产物在 /src/target/release/）
COPY --from=builder /src/target/release/noneos-handshake /usr/local/bin/noneos-handshake

# 拷贝容器默认配置（数据持久化到 /app/data，监听所有接口）
COPY docker/config.toml /app/config.toml

# 默认监听端口（见 config.toml）
EXPOSE 8081

# redb 数据库持久化目录，挂载卷以保留状态
VOLUME ["/app/data"]

# 以默认 config 启动；可用 `docker run ... -v my.toml:/app/config.toml` 覆盖
CMD ["noneos-handshake", "--config", "/app/config.toml"]
