import { userHashedId } from "@/features/auth/helpers";
import { OpenAIInstance } from "@/features/common/openai";
import { OpenAIStream, StreamingTextResponse } from "ai";
import { similaritySearchVectorWithScore } from "./azure-cog-search/azure-cog-vector-store";
import { initAndGuardChatSession } from "./chat-thread-service";
import { CosmosDBChatMessageHistory } from "./cosmosdb/cosmosdb";
import { PromptGPTProps } from "./models";

// システムプロンプトをBuffer.from()を使用してUTF-8でエンコード
const SYSTEM_PROMPT = Buffer.from(
  `あなたは ${process.env.NEXT_PUBLIC_AI_NAME}です。ユーザーからの質問に対して日本語で丁寧に回答します。\n`,
  'utf-8'
).toString();

const CONTEXT_PROMPT = ({
  context,
  userQuestion,
}: {
  context: string;
  userQuestion: string;
}) => {
  // テンプレートリテラルをBuffer.from()を使用してUTF-8でエンコード
  return Buffer.from(`
- 以下の文書の抜粋を基に、最終的な回答を作成してください。
- 答えが分からない場合は、分からないとだけ述べてください。推測での回答は避けてください。
- 回答はできるだけ詳細に、明細まで記載した文章にしてください
- 必ず回答の最後に引用を含め、最後にピリオドは付けないでください。
- 引用は必ず以下の形式で記載してください：{%citation items=[{name:"NAME",id:"ID"}]/%}
----------------
context:
${context}
----------------
question: ${userQuestion}
`, 'utf-8').toString();
};

export const ChatAPIGPTs = async (props: PromptGPTProps) => {
  const { lastHumanMessage, id, chatThread } = await initAndGuardChatSession(
    props
  );

  const openAI = OpenAIInstance();
  const userId = await userHashedId();

  // モデル選択のロジックを簡略化
  const chatAPIModel = props.chatAPIModel === "GPT-3" 
    ? "gpt-35-turbo-16k" 
    : "gpt-4o-mini";

  const chatDoc = props.chatDoc;

  const chatHistory = new CosmosDBChatMessageHistory({
    sessionId: chatThread.id,
    userId: userId,
  });

  const history = await chatHistory.getMessages();
  const topHistory = history.slice(-30); // より簡潔な配列スライス

  const relevantDocuments = await findRelevantDocuments(
    lastHumanMessage.content,
    chatDoc
  );

  // ドキュメントのコンテキスト作成時にエンコーディングを考慮
  const context = relevantDocuments
    .map((result, index) => {
      const content = Buffer.from(result.pageContent, 'utf-8')
        .toString()
        .replace(/(\r\n|\n|\r)/gm, "");
      return Buffer.from(
        `[${index}]. よくある質問: ${result.source}\nfile id: ${result.id}\n${content}`,
        'utf-8'
      ).toString();
    })
    .join("\n------\n");

  try {
    const response = await openAI.chat.completions.create({
      messages: [
        {
          role: "system",
          content: SYSTEM_PROMPT,
        },
        ...topHistory,
        {
          role: "user",
          content: CONTEXT_PROMPT({
            context,
            userQuestion: lastHumanMessage.content,
          }),
        },
      ],
      model: chatAPIModel,
      stream: true,
    });

    const stream = OpenAIStream(response, {
      async onCompletion(completion) {
        // 履歴保存時もエンコーディングを考慮
        await chatHistory.addMessage({
          content: Buffer.from(lastHumanMessage.content, 'utf-8').toString(),
          role: "user",
        });

        await chatHistory.addMessage(
          {
            content: Buffer.from(completion, 'utf-8').toString(),
            role: "assistant",
          },
          Buffer.from(context, 'utf-8').toString()
        );
      },
    });

    return new StreamingTextResponse(stream);
  } catch (e: unknown) {
    if (e instanceof Error) {
      return new Response(e.message, {
        status: 500,
        statusText: e.toString(),
      });
    }
    return new Response("An unknown error occurred.", {
      status: 500,
      statusText: "Unknown Error",
    });
  }
};

const findRelevantDocuments = async (query: string, chatDoc: string) => {
  const filter = chatDoc === 'all'
    ? "chatType eq 'doc'"
    : `chatType eq 'doc' and deptName eq 'sales'`;

  return await similaritySearchVectorWithScore(query, 10, {
    filter: filter,
  });
};