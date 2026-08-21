# ИИ-помощник «Афина» — план на Anthropic Claude API (текущее решение)

Модель: **Claude Sonnet 5** (баланс цены/качества; Haiku 4.5 остаётся вариантом для снижения
стоимости, Opus — если качество рассуждений на многошаговых финансовых вопросах окажется
недостаточным). Решение по модели можно менять без переделки контракта — контракт ниже
провайдеро-специфичен только в Edge Function, клиент про модель не знает.

## 1. Контракт Edge Function

**Название:** `ai-assistant` (`supabase/functions/ai-assistant/index.ts`). Один `POST`. Deno,
`npm:@anthropic-ai/sdk`.

**Аутентификация:** клиент вызывает `supabase.functions.invoke('ai-assistant', { body })` —
JWT сессии прикладывается автоматически. `verify_jwt = true` (по умолчанию) в
`supabase/config.toml`, плюс собственная проверка `auth.getUser()` по заголовку
`Authorization`, чтобы получить `user.id` для рейт-лимита. `user_id` из тела запроса
никогда не принимается.

**Секреты:** `supabase secrets set ANTHROPIC_API_KEY=...`, читается через
`Deno.env.get('ANTHROPIC_API_KEY')`. Ключ никогда не попадает в `EXPO_PUBLIC_*`, `app.json`
или бандл. `supabase/.env*` и `supabase/.temp/` — в `.gitignore`.

**Запрос (телефон → функция):**
```json
{
  "protocolVersion": 1,
  "context": {
    "today": "2026-08-21",
    "baseCurrency": "UZS",
    "rates": { "USD": 12650, "RUB": 135 },
    "accounts": [
      { "id": "acc_1", "name": "Kapitalbank", "type": "card",
        "balance": 4310000, "currency": "UZS", "cardLast4": "3463" }
    ],
    "counts": { "operations": 1842, "debts": 3, "plannedFlows": 11, "goals": 2 },
    "earliestOperationDate": "2025-11-02"
  },
  "messages": [
    { "role": "user", "content": "Сколько я потратила на еду в августе?" },
    { "role": "assistant", "content": [ /* raw blocks echoed verbatim */ ] },
    { "role": "user", "content": [ { "type": "tool_result", "tool_use_id": "...", "content": "{...}" } ] }
  ]
}
```
`context` компактный, за один ход (цель — до 8 КБ). Сервер убирает любые `role: "system"` из
присланного клиентом и добавляет ровно одно системное сообщение с `context` последним
элементом.

**Ответ (функция → телефон):**
```json
{
  "protocolVersion": 1,
  "toolsetVersion": 1,
  "stopReason": "tool_use",
  "content": [ /* raw Anthropic content blocks, без изменений */ ],
  "usage": { "inputTokens": 7412, "outputTokens": 288, "cacheReadInputTokens": 6100 },
  "limits": { "requestsRemainingHour": 27, "requestsRemainingDay": 183 }
}
```

**Ошибки:** `{ "error": { "code": "...", "message": "<по-русски>" } }`, коды:
`unauthenticated` (401), `rate_limited` (429), `turn_limit` / `payload_too_large` /
`unsupported_content` / `bad_protocol` (400), `upstream_error` (502), `misconfigured` (500).

**Вызов Anthropic:**
```ts
client.messages.create({
  model: "claude-sonnet-5",
  max_tokens: 4096,
  system: [{ type: "text", text: SYSTEM_PROMPT, cache_control: { type: "ephemeral" } }],
  tools: TOOLS,
  messages: sanitized,
})
```
Без streaming в v1 (React Native `fetch` не даёт надёжного `ReadableStream`,
`supabase.functions.invoke` буферизует ответ целиком).

**Белый список контента (реальная защита от абьюза):** отклонять любое сообщение с
`image`/`document`-блоками; разрешены только `text`, `thinking`, `tool_use`, `tool_result`.
В сочетании с тем, что тулы и системный промпт живут только на сервере, эндпоинт бесполезен
как общий Claude/vision-проксик даже при декомпиляции APK.

## 2. Дизайн тулов

Тринадцать тулов: 7 read + 6 write. `toolsetVersion` возвращается, чтобы клиент видел
дрейф версии; неизвестное имя тула → `tool_result` с `is_error: true`, никогда не крэш.

### Read-тулы (выполняются без подтверждения)

| Тул | Вход | На чём основан |
|---|---|---|
| `search_operations` | `{from, to, kind?, category?, accountId?, textQuery?, limit≤200}` | `listOperations` |
| `summarize_spending` | `{from, to, groupBy: 'category'\|'account'\|'month', kind?, currency?}` | `summarizeOperations` + `analyticsRange` |
| `get_account_details` | `{accountIds?}` | `listAccounts` (включая `rate`, `taxRate`, `maturityDate`) |
| `list_debts` | `{status?, direction?}` | `listDebts`, `listDebtHistory` по запросу |
| `list_planned_flows` | `{from?, to?, kind?}` | `listPlannedExpenses` + `listPlannedOccurrences` |
| `get_budgets_and_goals` | `{}` | `listBudgets`, `listFinancialGoals`, `src/goals.ts` |
| `project_balance` | `{currency, year, month, accountId?}` | `buildMonthProjection` |

Модель никогда не считает суммы сама — только цитирует то, что вернул тул.

### Write-тулы (никогда не пишут — только черновик-предложение)

| Тул | Поля | При подтверждении → |
|---|---|---|
| `propose_operation` | `{kind, title, category, amount>0, currency, accountId, date, note?}` | `createOperation(input, 'ai')` |
| `propose_transfer` | `{fromAccountId, toAccountId, fromAmount, toAmount, exchangeRate?, note?, date}` | `recordTransfer` |
| `propose_debt` | `{person, title, direction, originalAmount, currency, accountId?, startDate, dueDate, note?}` | `createDebt` |
| `propose_debt_payment` | `{debtId, amount, date, accountId, exchangeRate?, note?}` | `recordDebtPayment` |
| `propose_planned_flow` | `{title, category, amount, currency, accountId?, startDate, endDate?, repeat, kind, ...}` | `savePlannedExpense` |
| `propose_bill_split` | `{title, total, currency, accountId, date, myShare, participants:[{name, amount, dueDate}]}` | 1 операция + N долгов, одна транзакция |

Разделение счёта: полная сумма — расход на плательщика, плюс по одному долгу
`owed_to_me` на участника (`accountId` = счёт плательщика, он же счёт погашения по умолчанию).
Долг без срока → +30 дней. Инвариант перед подтверждением: `myShare + Σ participants.amount
=== total` (± 0.01).

Провенанс: `createOperation` получает необязательный `source` (по умолчанию `'manual'`,
без изменения существующих вызовов), плюс `'ai'` в `FinancialOperation['source']`
(`src/types.ts`).

**Распознавание чеков — без отдельного тула.** OCR уже есть (`@react-native-ml-kit/text-recognition`,
используется для скриншотов счетов) — извлечённый текст с фото отправляется как обычное
сообщение пользователя, модель вызывает `propose_operation`/`propose_bill_split` из текста.
Фото никогда не покидает телефон.

Клиентская валидация каждого предложения (модель может выдумать id): `accountId`/`debtId`
резолвятся по реальным строкам; неизвестный id → карточка с несделанным выбором счёта;
`amount > 0`; валюта — из `CurrencySettings.rates` ∪ `baseCurrency`; даты — ISO-парсабельны.

## 3. Состояние диалога

Только локальная SQLite, без синка в Supabase — тот же принцип, что у `sms_drafts`
(raw-текст никогда не уходит с телефона). Две новые таблицы:
`ai_chat_messages(id, role, content_json, created_at)`,
`ai_proposals(id, group_id, message_id, kind, payload_json, status, created_entity_kind,
created_entity_id, created_at, updated_at)`. Храним последние 40 сообщений локально,
в запрос уходят последние ~20 ходов.

## 4. Контроль стоимости/абьюза

1. JWT обязателен, `user_id` — только из `auth.getUser()`.
2. Модель/промпт/тулы/`max_tokens` — только на сервере, клиент не может их подменить.
3. Белый список типов контента (без image/document).
4. Лимит тела запроса 256 КБ, `context` — 16 КБ.
5. Лимит ходов ассистента в одном запросе — 8.
6. `ai_usage_log` — RLS включён, **без policy и grant для `authenticated`**: читает/пишет
   только service-role клиент внутри функции. 30 запросов/час, 200/день на пользователя
   (обсуждалось, не финализировано пользователем).
7. Жёсткий месячный лимит трат в консоли Anthropic — основной страховочный барьер.

## 5. Интеграция в приложение

Полноэкранная модалка (`animationType="slide"`, `presentationStyle="pageSheet"`) — как
`ImportDraftsModal`. Точки входа: строка в «Профиль», плюс иконка в заголовке «Обзора».
Монтируется в `AppContent` (не внутри `Profile`), чтобы после подтверждения дёргать
существующие `reload*`-замыкания и затем debounced `uploadLocalDataToCloud`.

`cloudSync.ts` — без изменений (подтверждённые предложения становятся обычными
операциями/долгами/переводами, которые уже синкаются; сам чат и черновики — нет).

`database.ts` — только аддитивно: `listAiChatMessages`, `appendAiChatMessage`, `clearAiChat`,
`createAiProposals`, `listAiProposals`, `countPendingAiProposals`, `dismissAiProposal`,
`commitAiProposal`. `commitAiProposal` — один `enqueue` + одна `withTransactionAsync`,
которая и создаёт сущности, и переводит `ai_proposals.status` в `'confirmed'` за один шаг
(идемпотентность при повторном тапе). Извлечь `createOperationCore`/`createDebtCore`
(без транзакции внутри) — по аналогии с существующим `*Core`-соглашением в файле — чтобы не
дублировать SQL между обычным путём и `commitAiProposal`.

## 6. Порядок реализации

0. Убедиться, что `operations.source` в Supabase допускает `'push'` и `'ai'` (уже нужно
   расширить constraint — на момент прошлой сессии это отдельно всплывший баг).
1. SQL-миграция: расширение constraint + `ai_usage_log` (RLS без policy).
2. `src/types.ts`: `'ai'` в `source`, типы `AiProposal`/`AiChatMessage`.
3. `src/ai/protocol.ts`: типы запроса/ответа/ошибок, `PROTOCOL_VERSION`.
4. `src/database.ts`: новые таблицы, `PRAGMA user_version` +1, `createOperationCore`/
   `createDebtCore`, восемь новых функций + `commitAiProposal`.
5. `supabase/config.toml` + `supabase/functions/ai-assistant/index.ts` — первая Edge Function
   в этом репозитории.
6. `src/ai/client.ts` — обёртка над `supabase.functions.invoke`.
7. `src/ai/context.ts` — сборка компактного `AssistantContext`.
8. `src/ai/tools.ts` — реестр исполнителей тулов.
9. `src/ai/loop.ts` — цикл хода: отправить → если `tool_use`, выполнить все вызовы, вернуть
   все `tool_result` одним сообщением → сохранить content вербатим → создать `ai_proposals`
   для write-тулов → остановиться на `end_turn`/`refusal`/`max_tokens`/8 итерациях.
10. `src/ai/receipt.ts` — OCR → текст → сообщение пользователя.
11. `App.tsx` — `AiProposalCard` (по образцу `ImportDraftCard`), `AiAssistantModal` (по
    образцу существующих модалок), точки входа, бейдж непросмотренных предложений.
12. Обзор: `finance-domain` на сплит-билл и транзакционность подтверждения; `data-sync` на
    миграцию и локальность хранения; затем независимый Codex-проход.

### Осознанно не в v1

Streaming; голосовой ввод; несколько диалогов; серверные Postgres-чтения; vision-разбор фото
(только текст OCR); синхронизация истории чата; проактивные/плановые инсайты; предложения по
бюджетам/целям; полные формы редактирования в карточках предложений (кроме
счёта/суммы/категории); любые тулы update/delete/reverse — только создание.

## Открытые вопросы (на момент написания)

1. Лимиты запросов (30/час, 200/день) и месячный потолок трат в консоли Anthropic — не
   финализированы.
2. Как именно определять `dueDate` для долгов из сплит-билла без явного срока — решено:
   +30 дней по умолчанию.
