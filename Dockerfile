# Üretim imajı — çok aşamalı.
#
# Geliştirme imajı (Dockerfile.dev) kaynak kodu bind-mount eder ve tsx watch
# kullanır. Bu imaj farklı: yalnızca üretim bağımlılıkları, root olmayan
# kullanıcı ve doğrudan Node ile çalıştırma.
#
# Build:  docker build -t senkron-izleme .
# Çalıştır: docker run --rm -e DATABASE_URL=... senkron-izleme node src/api/index.ts

# ---------------------------------------------------------------- 1) deps
FROM node:24-alpine AS deps
WORKDIR /app
COPY package.json package-lock.json* ./
# npm ci: lock dosyasına birebir uyar, üretimde "çalışıyordu ama" durumunu önler
RUN npm ci --omit=dev --no-audit --no-fund

# ------------------------------------------------------------- 2) builder
FROM node:24-alpine AS builder
WORKDIR /app
COPY package.json package-lock.json* ./
RUN npm ci --no-audit --no-fund
COPY tsconfig*.json ./
COPY src ./src
COPY scripts ./scripts
COPY public ./public
# Tip kontrolü BUILD sırasında yapılır: bozuk tip üretime çıkamaz.
RUN npm run typecheck
# Paylaşılan protokolü tarayıcı için derle
RUN npm run build:client

# ------------------------------------------------------------ 3) runtime
FROM node:24-alpine AS runtime

# ffmpeg yalnızca worker'a gerekir ama tek imaj tutuyoruz: üç servis de aynı
# kod tabanını çalıştırıyor, ayrı imaj bakımı maliyeti kazancından fazla.
RUN apk add --no-cache ffmpeg tini

ENV NODE_ENV=production
WORKDIR /app

COPY --from=deps    /app/node_modules ./node_modules
COPY --from=builder /app/src          ./src
COPY --from=builder /app/scripts      ./scripts
COPY --from=builder /app/public       ./public
COPY --from=builder /app/tsconfig.json ./
COPY migrations ./migrations
COPY package.json ./

# node imajında hazır gelen non-root kullanıcı. Root çalıştırmak, konteyner
# kaçışı durumunda saldırgana host'ta root vermeye yaklaştırır.
RUN chown -R node:node /app
USER node

# Node 24 TypeScript'i yerel olarak soyar (type stripping) — tsx'e gerek yok.
# tsconfig'deki `erasableSyntaxOnly` bunu garanti eder.
EXPOSE 8090 8091

ENTRYPOINT ["/sbin/tini", "--"]
CMD ["node", "src/api/index.ts"]
