# Elenchos

AI-аналитик листингов лаунчпада **Pons** (Robinhood Chain). Elenchos собирает все токены с Pons прямо из блокчейна, оценивает каждый по 12 метрикам и даёт вердикт: **Заходить / Ждать / Пропустить**.

## Структура

```
index.html          сайт целиком (HTML + CSS + JS, без сборки)
server/index.js     HTTP-сервер: API + раздача сайта
server/indexer.js   индексатор Pons на Robinhood Chain
server/tokeninfo.js разбор getTokenInfo() → лого, описание, соцсети
server/scoring.js   формула оценки (та же, что во фронте)
server/review.js    AI-обзор через OpenRouter или Anthropic API
test/               тесты на мок-блокчейне (npm test)
```

## Деплой на Railway

1. New Project → Deploy from GitHub → этот репозиторий. `railway.json` уже настроен (`npm start`, healthcheck `/healthz`).
2. Variables:
   - `RPC_URL` — RPC Robinhood Chain (chain id 4663). Бесплатный публичный: `https://rpc.mainnet.chain.robinhood.com` (с лимитами). Для нагрузки лучше Alchemy/QuickNode. Без него сайт работает на демо-данных.
   - `OPENROUTER_API_KEY` — ключ OpenRouter (модель по умолчанию `anthropic/claude-sonnet-5.5`, меняется через `OPENROUTER_MODEL`). Вместо него можно `ANTHROPIC_API_KEY`. Без ключа AI-обзор заменяется алгоритмическим.
   - остальное по желанию, см. `.env.example`.
3. Settings → Networking → Generate Domain. Сайт и API живут на одном домене.

После старта индексатор догоняет последние `BACKFILL_HOURS` (по умолчанию 6 ч), прогресс виден в `/api/status`. Пока он синхронизируется, сайт показывает уже найденные токены (или демо, если их ещё нет).

Локально:

```bash
npm install
RPC_URL=... ANTHROPIC_API_KEY=... npm start   # http://localhost:8080
npm test
```

## API

| Метод | Путь | Что отдаёт |
|---|---|---|
| GET | `/api/status` | синхронизация, число токенов, цена ETH, включён ли AI |
| GET | `/api/listings` | `{ status, tokens: [...] }` — до `LIST_LIMIT` токенов, отсортированы по объёму |
| GET | `/api/token/:address` | один токен |
| POST | `/api/review/:address` | AI-обзор: `{verdict, confidence, summary, pros, risks, entry, stop, target, size}` |

AI-обзор строится из метрик, которые сервер посчитал сам: клиент присылает только адрес. Поэтому эндпоинт нельзя использовать как бесплатный доступ к модели. Обзоры кэшируются на 5 минут, на один IP приходится не больше 6 запросов в минуту.

Если фронт лежит на другом домене, задайте перед скриптом `window.ELENCHOS_API = "https://ваш-api"` и `CORS_ORIGIN` на сервере.

## Откуда берутся метрики

Pons работает на **V2** (V1, то есть фабрики `0xA5aA…1feB` и `0x0c37…77a4`, не используется с осени 2026). Адреса проверены по блокчейну:

| Контракт | Адрес |
|---|---|
| PonsV2LaunchFactory | `0x7ed598bcef8bd9edd8c97a195c6d13f40801ec7e` |
| PonsV2LaunchDeployer | `0x3711cea4feade896c913c68f01eda97cb06d1a42` |
| Uniswap V4 PoolManager | `0x8366a39cc670b4001a1121b8f6a443a643e40951` |
| Pons hook | `0xe5e702641ea86f4ae6cc3cdaed2b886f976be044` |
| Locker | `0x267444d099b10fb5ed7c3cc7b7c767adca574952` |

Как устроен V2:

- `TokenLaunched(token, curve, deployer, pairToken, launchConfigId, graduationThreshold)` на фабрике. `pairToken = 0x0` значит нативный ETH.
- До graduation сделки идут на контракте-кривой: `CurveBuy` и `CurveSell`. `curve.getReserves()` возвращает `(quote, token)`. В `quote` есть «фантомная» ликвидность из `getLaunchConfig(id).phantomQuote` (1.68 ETH). Цена = quote / token, прогресс = (quote − phantom) / threshold (4.2 ETH).
- Graduation: `PoolGraduated` на фабрике, а в той же транзакции `Initialize` пула Uniswap V4 с хуком Pons. Дальше сделки — это `Swap(id, …)` на PoolManager. Ликвидность навсегда заблокирована в locker.
- `getTokenInfo()` → `(deployer, logo, description, (twitter, telegram, discord, website, farcaster))`.

| Метрика | Как считается |
|---|---|
| Цена, MC | резервы кривой (или `sqrtPriceX96` в V4) × цена ETH (CoinGecko) × supply |
| Ликвидность | реальные ETH в кривой/пуле × 2 |
| Холдеры, топ-10 | балансы из `Transfer` без кривой, PoolManager, фабрики и locker |
| Доля дева | баланс деплоера |
| Снайперы | доля supply у адресов, купивших в первые `SNIPER_BLOCKS` блоков (блок ≈ 0,1 с) |
| Покупки/продажи, объём 24ч | `CurveBuy`/`CurveSell` и V4 `Swap` за сутки |
| История дева | прошлые запуски того же деплоера. Rug — дев продавал, а MC упал больше чем на 90% от пика |

Ограничения: всё хранится в памяти, и после рестарта сервис заново догоняет последние `BACKFILL_HOURS` (около минуты). Токены старше окна, история дева вне окна и токены V1 не видны. Мёртвые токены (без сделок дольше `DEAD_AFTER_MIN` при прогрессе меньше 10%) убираются из списка.

Логотипы отдаются через `/img?u=…`: браузер блокирует картинки IPFS и gmgn на чужих сайтах. Сервер перебирает несколько IPFS-шлюзов, проверяет, что это действительно картинка, и кэширует результат.

Живая проверка: `npm run check:live`. Тесты (`npm test`) запускаются при каждой сборке на Railway: если они упали, деплой не пойдёт.

## Оценка

Итоговая оценка — взвешенная сумма 12 метрик (0–100). От 66 и выше — «Заходить», 46–65 — «Ждать», ниже 46 — «Пропустить». Если у дева два и больше рагпулла или после graduation ликвидность не заблокирована, оценка ограничивается сверху.

> Не является финансовой рекомендацией. Мемкоины крайне волатильны.

## Бренд

**Elenchos** (греч. ἔλεγχος) — «перекрёстный допрос», метод Сократа: утверждение проверяют вопросами, пока не останется правда. Мы так же проверяем каждый токен.

Файлы в папке `brand/`:

| Файл | Для чего |
|---|---|
| `elenchos-logo.svg/.png`, `elenchos-logo-white.svg/.png` | горизонтальный логотип: знак и вордмарк, для светлого и тёмного фона |
| `elenchos-mark.svg/.png`, `elenchos-mark-white.svg/.png` | только знак |
| `x-avatar.png` | аватар X, 400×400 |
| `x-banner.png` | шапка профиля X, 1500×500 |

Знак — буква E из брусков. Средняя перекладина отделена от основы и окрашена в зелёный: это «проверка», в которой токен либо держится, либо нет. Вордмарк — Inter Display Bold капсом с разрядкой 0.14em, переведён в кривые. Цвета: чернила `#1C1A17`, крем `#FBF8F2`, зелёный `#3B8A4E` (на тёмном фоне `#5BBF73`).
