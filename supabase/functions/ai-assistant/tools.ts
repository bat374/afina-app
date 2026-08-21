// Anthropic Messages API tool declarations for the "Афина" AI assistant. Lives entirely on the
// server -- the client never sends or sees this list, so a decompiled APK can't redefine what the
// model is allowed to call. Bump TOOLSET_VERSION whenever a tool's name/shape changes so the
// client can detect drift (see src/ai/protocol.ts).
export const TOOLSET_VERSION = 1;

// Read tools: execute silently on the phone against local SQLite, return already-computed
// numbers. The system prompt (see index.ts) tells the model to never compute a sum itself.
const READ_TOOLS = [
  {
    name: 'search_operations',
    description: 'Находит операции пользователя по фильтрам и возвращает готовые записи из локальной базы. Не используйте для подсчёта сумм — для сумм вызывайте summarize_spending.',
    input_schema: {
      type: 'object',
      properties: {
        from: { type: 'string', description: 'Начало периода, ISO YYYY-MM-DD' },
        to: { type: 'string', description: 'Конец периода, ISO YYYY-MM-DD' },
        accountId: { type: 'string' },
        category: { type: 'string' },
        textQuery: { type: 'string', description: 'Подстрока в названии операции' },
        kind: { type: 'string', enum: ['income', 'expense', 'all'] },
        limit: { type: 'integer', description: 'Максимум записей, по умолчанию 50' },
      },
      required: ['from', 'to'],
    },
  },
  {
    name: 'summarize_spending',
    description: 'Считает доходы/расходы за период — единственный правильный способ узнать сумму. Никогда не вычисляйте сумму самостоятельно, всегда вызывайте этот тул.',
    input_schema: {
      type: 'object',
      properties: {
        from: { type: 'string' },
        to: { type: 'string' },
        groupBy: { type: 'string', enum: ['category', 'account', 'month'] },
        kind: { type: 'string', enum: ['income', 'expense', 'all'] },
        currency: { type: 'string' },
      },
      required: ['from', 'to'],
    },
  },
  {
    name: 'get_account_details',
    description: 'Возвращает счета пользователя с балансом, ставкой, налогом на проценты, датой окончания вклада и т.п.',
    input_schema: { type: 'object', properties: { accountIds: { type: 'array', items: { type: 'string' } } } },
  },
  {
    name: 'list_debts',
    description: 'Возвращает долги пользователя (кто кому должен) и их статус.',
    input_schema: {
      type: 'object',
      properties: {
        status: { type: 'string', enum: ['active', 'overdue', 'paid'] },
        direction: { type: 'string', enum: ['owed_to_me', 'i_owe'] },
      },
    },
  },
  {
    name: 'list_planned_flows',
    description: 'Возвращает запланированные (регулярные и разовые) доходы/расходы пользователя.',
    input_schema: {
      type: 'object',
      properties: { from: { type: 'string' }, to: { type: 'string' }, kind: { type: 'string', enum: ['income', 'expense', 'all'] } },
    },
  },
  {
    name: 'get_budgets_and_goals',
    description: 'Возвращает бюджеты по категориям и финансовые цели пользователя с текущим прогрессом.',
    input_schema: { type: 'object', properties: {} },
  },
  {
    name: 'project_balance',
    description: 'Считает прогнозный остаток по счету/счетам на конец указанного месяца с учётом процентов и плановых движений.',
    input_schema: {
      type: 'object',
      properties: {
        currency: { type: 'string' },
        year: { type: 'integer' },
        month: { type: 'integer', description: '0-11, как в JS Date' },
        accountId: { type: 'string' },
      },
      required: ['currency', 'year', 'month'],
    },
  },
];

// Write tools: NEVER write directly. Each returns a proposal the client renders as a confirm
// card (src/database.ts createAiProposals/commitAiProposal) — nothing touches the database until
// the user taps a real confirm button. No update/delete/reverse tools in v1 — create-only.
const WRITE_TOOLS = [
  {
    name: 'propose_operation',
    description: 'Готовит предложение о новой операции (доход или расход). НЕ создаёт запись — пользователь подтверждает вручную.',
    input_schema: {
      type: 'object',
      properties: {
        title: { type: 'string' },
        category: { type: 'string' },
        amount: { type: 'number' },
        currency: { type: 'string' },
        accountId: { type: 'string' },
        date: { type: 'string' },
        operationKind: { type: 'string', enum: ['income', 'expense'] },
        note: { type: 'string' },
      },
      required: ['title', 'category', 'amount', 'currency', 'date', 'operationKind'],
    },
  },
  {
    name: 'propose_transfer',
    description: 'Готовит предложение о переводе между двумя счетами пользователя. НЕ создаёт запись.',
    input_schema: {
      type: 'object',
      properties: {
        fromAccountId: { type: 'string' },
        toAccountId: { type: 'string' },
        fromAmount: { type: 'number' },
        toAmount: { type: 'number' },
        exchangeRate: { type: 'number' },
        note: { type: 'string' },
        date: { type: 'string' },
      },
      required: ['fromAccountId', 'toAccountId', 'fromAmount', 'toAmount', 'date'],
    },
  },
  {
    name: 'propose_debt',
    description: 'Готовит предложение о создании долга (кто-то должен пользователю или пользователь должен кому-то). НЕ создаёт запись.',
    input_schema: {
      type: 'object',
      properties: {
        person: { type: 'string' },
        title: { type: 'string' },
        direction: { type: 'string', enum: ['owed_to_me', 'i_owe'] },
        originalAmount: { type: 'number' },
        currency: { type: 'string' },
        accountId: { type: 'string' },
        startDate: { type: 'string' },
        dueDate: { type: 'string' },
        note: { type: 'string' },
      },
      required: ['person', 'title', 'direction', 'originalAmount', 'currency', 'startDate', 'dueDate'],
    },
  },
  {
    name: 'propose_debt_payment',
    description: 'Готовит предложение о погашении существующего долга. НЕ создаёт запись.',
    input_schema: {
      type: 'object',
      properties: {
        debtId: { type: 'string' },
        amount: { type: 'number' },
        date: { type: 'string' },
        accountId: { type: 'string' },
        exchangeRate: { type: 'number' },
        note: { type: 'string' },
      },
      required: ['debtId', 'amount', 'date'],
    },
  },
  {
    name: 'propose_planned_flow',
    description: 'Готовит предложение о новом плановом (регулярном или разовом) доходе/расходе. НЕ создаёт запись.',
    input_schema: {
      type: 'object',
      properties: {
        title: { type: 'string' },
        category: { type: 'string' },
        amount: { type: 'number' },
        currency: { type: 'string' },
        accountId: { type: 'string' },
        startDate: { type: 'string' },
        endDate: { type: 'string' },
        repeat: { type: 'string', enum: ['once', 'daily', 'weekly', 'monthly', 'yearly', 'custom'] },
        flowKind: { type: 'string', enum: ['income', 'expense'] },
        repeatInterval: { type: 'integer' },
        repeatUnit: { type: 'string', enum: ['day', 'week', 'month', 'year'] },
      },
      required: ['title', 'category', 'amount', 'currency', 'startDate', 'repeat', 'flowKind'],
    },
  },
  {
    name: 'propose_bill_split',
    description: 'Готовит предложение о разделении счёта на несколько человек. НЕ создаёт записи. Не вычисляйте доли самостоятельно: если суммы участников не названы явно пользователем, оставьте поле amount у участника пустым — приложение разделит сумму равными долями само.',
    input_schema: {
      type: 'object',
      properties: {
        title: { type: 'string' },
        category: { type: 'string' },
        totalAmount: { type: 'number', description: 'Полная сумма счёта' },
        currency: { type: 'string' },
        payingAccountId: { type: 'string' },
        date: { type: 'string' },
        dueDate: { type: 'string', description: 'Если не указано, приложение подставит +30 дней' },
        participants: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              name: { type: 'string' },
              amount: { type: 'number', description: 'Только если пользователь назвал сумму явно' },
            },
            required: ['name'],
          },
        },
      },
      required: ['title', 'category', 'totalAmount', 'currency', 'date', 'participants'],
    },
  },
];

export const TOOLS = [...READ_TOOLS, ...WRITE_TOOLS];
export const WRITE_TOOL_NAMES = new Set(WRITE_TOOLS.map((tool) => tool.name));
