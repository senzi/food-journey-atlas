type JourneyRegion = {
  key: string;
  label: string;
  province: string;
};

type JourneyKeyword = {
  name: string;
  type: string;
};

type JourneyQueryRequest = {
  text?: unknown;
  options?: {
    regions?: unknown;
    years?: unknown;
    keywords?: unknown;
  };
};

type JourneyConditions = {
  regionKey?: string;
  year?: number;
  nodeCount?: 2 | 3 | 5 | 7;
  keyword?: string;
  includePossible?: boolean;
};

type JourneyQueryResult =
  | {
      status: "parsed";
      conditions: JourneyConditions;
      summary: string;
    }
  | {
      status: "needs_clarification";
      message: string;
    }
  | {
      status: "irrelevant";
      message: string;
    };

type Env = {
  deepseek_key?: string;
  DEEPSEEK_API_KEY?: string;
  DEEPSEEK_MODEL?: string;
  DEEPSEEK_BASE_URL?: string;
};

const NODE_COUNTS = [2, 3, 5, 7] as const;
const MAX_TEXT_LENGTH = 500;

function normalizeOptions(payload: JourneyQueryRequest) {
  const rawRegions = Array.isArray(payload.options?.regions)
    ? payload.options.regions
    : [];
  const regions = rawRegions
    .filter(
      (item): item is JourneyRegion =>
        !!item &&
        typeof item === "object" &&
        typeof (item as JourneyRegion).key === "string" &&
        typeof (item as JourneyRegion).label === "string" &&
        typeof (item as JourneyRegion).province === "string",
    )
    .slice(0, 160)
    .map(({ key, label, province }) => ({
      key: key.slice(0, 120),
      label: label.slice(0, 80),
      province: province.slice(0, 80),
    }));
  const years = Array.isArray(payload.options?.years)
    ? payload.options.years
        .filter(
          (value): value is number =>
            Number.isInteger(value) && value >= 2000 && value <= 2100,
        )
        .slice(0, 50)
    : [];
  const rawKeywords = Array.isArray(payload.options?.keywords)
    ? payload.options.keywords
    : [];
  const keywords = rawKeywords
    .filter(
      (item): item is JourneyKeyword =>
        !!item &&
        typeof item === "object" &&
        typeof (item as JourneyKeyword).name === "string" &&
        typeof (item as JourneyKeyword).type === "string",
    )
    .slice(0, 160)
    .map(({ name, type }) => ({
      name: name.slice(0, 60),
      type: type.slice(0, 40),
    }));

  return { regions, years, keywords };
}

function buildPrompt(options: ReturnType<typeof normalizeOptions>) {
  const regionChoices = options.regions.map(
    (item) => `${item.key}（${item.province} / ${item.label}）`,
  );
  const keywordChoices = options.keywords.map(
    (item) => `${item.name}（${item.type}）`,
  );

  return `你负责把一句自然语言转换成“美食旅程筛选条件”。只理解筛选意图，不回答知识问题。

允许的字段和可选项：
- regionKey：只能从以下地区 key 中选择；没有明确地区就省略。
${regionChoices.map((item) => `  - ${item}`).join("\n")}
- year：只能选择 ${options.years.join("、")}；没有明确年份就省略。
- nodeCount：只能选择 ${NODE_COUNTS.join("、")}。用户说“两站/三个点”等可换算；没有明确数量就省略。
- keyword：只能从以下已收录词中选择一个；若用户说的是清楚的具体菜名或食材、但不在列表中，可保留用户原词；不要把泛泛的“好吃”“美食”当关键词。
${keywordChoices.map((item) => `  - ${item}`).join("\n")}
- includePossible：只有用户明确表示“也看可能地点、低可信地点、候选地点”时才为 true；明确只看可靠记录时为 false；否则省略。

判断规则：
1. 只要能可靠提取至少一个条件，返回 parsed。不要为了填满字段而猜测。
2. 话题与选择美食旅程明显无关，返回 irrelevant。
3. 看起来是在选择旅程，但关键信息含糊、冲突，或提到的地区无法对应任何可选项，返回 needs_clarification。
4. “附近、随便、都行、不知道”等不是具体条件；如果整句话只有这些内容，返回 needs_clarification。
5. 不得自行发明地区 key、年份或节点数量。

只返回一个 JSON 对象，格式三选一：
{"status":"parsed","conditions":{"regionKey":"可选","year":2024,"nodeCount":3,"keyword":"可选","includePossible":false},"summary":"用自然中文简要复述已理解的条件"}
{"status":"needs_clarification","message":"一句简短、可直接回答的追问"}
{"status":"irrelevant","message":"这句话和旅程条件关系不大，可以换一种说法。"}
不要输出 Markdown，不要解释规则。`;
}

function parseModelJson(content: string): unknown {
  const trimmed = content.trim();
  const unfenced = trimmed
    .replace(/^```(?:json)?\s*/i, "")
    .replace(/\s*```$/, "");
  return JSON.parse(unfenced);
}

function validateResult(
  value: unknown,
  options: ReturnType<typeof normalizeOptions>,
): JourneyQueryResult {
  if (!value || typeof value !== "object") {
    throw new Error("模型没有返回可识别的结果");
  }
  const result = value as Record<string, unknown>;
  if (result.status === "irrelevant") {
    return {
      status: "irrelevant",
      message:
        typeof result.message === "string" && result.message.trim()
          ? result.message.trim().slice(0, 120)
          : "这句话和旅程条件关系不大，可以换一种说法。",
    };
  }
  if (result.status === "needs_clarification") {
    return {
      status: "needs_clarification",
      message:
        typeof result.message === "string" && result.message.trim()
          ? result.message.trim().slice(0, 120)
          : "我还不能确定你想怎么选，可以再具体一点吗？",
    };
  }
  if (result.status !== "parsed") {
    throw new Error("模型返回了未知状态");
  }

  const raw =
    result.conditions && typeof result.conditions === "object"
      ? (result.conditions as Record<string, unknown>)
      : {};
  const conditions: JourneyConditions = {};
  if (typeof raw.regionKey === "string") {
    if (!options.regions.some((item) => item.key === raw.regionKey)) {
      return {
        status: "needs_clarification",
        message: "这个地区不在现有足迹范围里，可以换一个已收录地区吗？",
      };
    }
    conditions.regionKey = raw.regionKey;
  }
  if (typeof raw.year === "number") {
    if (!options.years.includes(raw.year)) {
      return {
        status: "needs_clarification",
        message: "这个年份没有收录记录，可以换一个有记录的年份吗？",
      };
    }
    conditions.year = raw.year;
  }
  if (typeof raw.nodeCount === "number") {
    if (!NODE_COUNTS.includes(raw.nodeCount as (typeof NODE_COUNTS)[number])) {
      return {
        status: "needs_clarification",
        message: "旅程节点可以选 2、3、5 或 7 个，你更想要哪一种？",
      };
    }
    conditions.nodeCount = raw.nodeCount as JourneyConditions["nodeCount"];
  }
  if (typeof raw.keyword === "string" && raw.keyword.trim()) {
    conditions.keyword = raw.keyword.trim().slice(0, 40);
  }
  if (typeof raw.includePossible === "boolean") {
    conditions.includePossible = raw.includePossible;
  }
  if (!Object.keys(conditions).length) {
    return {
      status: "needs_clarification",
      message: "我还没找到可以使用的条件，可以说说地区、年份、想吃什么或节点数量吗？",
    };
  }
  return {
    status: "parsed",
    conditions,
    summary:
      typeof result.summary === "string" && result.summary.trim()
        ? result.summary.trim().slice(0, 160)
        : "已理解这些条件，你还可以继续手动调整。",
  };
}

export async function handleJourneyQuery(
  request: Request,
  env: Env,
): Promise<Response> {
  if (request.method !== "POST") {
    return Response.json({ error: "Method not allowed" }, { status: 405 });
  }

  let payload: JourneyQueryRequest;
  try {
    payload = (await request.json()) as JourneyQueryRequest;
  } catch {
    return Response.json({ error: "请求内容不是有效 JSON" }, { status: 400 });
  }
  const text = typeof payload.text === "string" ? payload.text.trim() : "";
  if (!text) {
    return Response.json({ error: "请先写一句你的想法" }, { status: 400 });
  }
  if (text.length > MAX_TEXT_LENGTH) {
    return Response.json(
      { error: `最多输入 ${MAX_TEXT_LENGTH} 个字` },
      { status: 400 },
    );
  }
  const options = normalizeOptions(payload);
  if (!options.regions.length || !options.years.length) {
    return Response.json({ error: "可选条件不完整" }, { status: 400 });
  }

  const apiKey = env.deepseek_key || env.DEEPSEEK_API_KEY;
  if (!apiKey) {
    return Response.json(
      { error: "服务端还没有配置 DeepSeek 密钥" },
      { status: 503 },
    );
  }

  try {
    const baseUrl = (env.DEEPSEEK_BASE_URL || "https://api.deepseek.com").replace(
      /\/+$/,
      "",
    );
    const response = await fetch(`${baseUrl}/chat/completions`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: env.DEEPSEEK_MODEL || "deepseek-v4-flash",
        messages: [
          { role: "system", content: buildPrompt(options) },
          { role: "user", content: text },
        ],
        response_format: { type: "json_object" },
        thinking: { type: "disabled" },
        temperature: 0.1,
        max_tokens: 600,
        stream: false,
      }),
      signal: AbortSignal.timeout(45_000),
    });
    const raw = (await response.json()) as {
      error?: { message?: string };
      choices?: Array<{ message?: { content?: string } }>;
    };
    if (!response.ok) {
      throw new Error(raw.error?.message || `DeepSeek HTTP ${response.status}`);
    }
    const content = raw.choices?.[0]?.message?.content;
    if (!content) throw new Error("DeepSeek 没有返回内容");
    const result = validateResult(parseModelJson(content), options);
    return Response.json(result);
  } catch (error) {
    console.error("Journey query parsing failed", error);
    return Response.json(
      { error: "暂时没有理解成功，请稍后重试或直接使用下面的选项" },
      { status: 502 },
    );
  }
}
