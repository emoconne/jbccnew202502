import { userHashedId } from "@/features/auth/helpers";
import { OpenAIInstance } from "@/features/common/openai";
import { OpenAIStream, StreamingTextResponse } from "ai";
import { similaritySearchVectorWithScore } from "./azure-cog-search/azure-cog-vector-store";
import { initAndGuardChatSession } from "./chat-thread-service";
import { CosmosDBChatMessageHistory } from "./cosmosdb/cosmosdb";
import { PromptGPTProps } from "./models";

// 基本的なシステムプロンプト
const BASE_SYSTEM_PROMPT = `あなたは ${process.env.NEXT_PUBLIC_AI_NAME} です。
ユーザーからの質問に対して日本語で丁寧に回答します。
回答は簡潔かつ明確にしてください。`;

// 文書ありの場合のシステムプロンプト
const DOCS_SYSTEM_PROMPT = `${BASE_SYSTEM_PROMPT}
以下のルールに従って回答を作成してください：
1. 提供された文書の情報のみを使用して回答してください
2. 文書に記載がない内容については「その情報は文書に含まれていません」と回答してください
3. 回答の最後に必ず文書の引用を含めてください
4. 引用は {%citation items=[{name:"文書名",id:"文書ID"}]/%} の形式で記載してください
5. 推測や一般的な情報による補完は避けてください`;

// 文書なしの場合のシステムプロンプト
const NO_DOCS_SYSTEM_PROMPT = `${BASE_SYSTEM_PROMPT}
申し訳ありませんが、お尋ねの内容に関する文書情報が見つかりませんでした。
その旨を簡潔に回答してください。
引用や推測による回答は行わないでください。`;

// 文書ありの場合のコンテキストプロンプト
const constructDocsPrompt = (context: string, userQuestion: string) => {
  return `質問内容：${userQuestion}

参照文書：
${context}

上記の文書に基づいて回答を作成してください。
文書に含まれていない情報については「その情報は文書に含まれていません」と回答してください。`;
};

// 文書なしの場合のコンテキストプロンプト
const constructNoDocsPrompt = (userQuestion: string) => {
  return `質問内容：${userQuestion}

申し訳ありませんが、その質問に関する文書情報が見つかりませんでした。`;
};

export const ChatAPIData = async (props: PromptGPTProps) => {
  const { lastHumanMessage, id, chatThread } = await initAndGuardChatSession(props);
  const openAI = OpenAIInstance();
  const userId = await userHashedId();

  const chatAPIModel = props.chatAPIModel === "GPT-3" 
    ? "gpt-35-turbo-16k" 
    : "gpt-4o-mini";

  const chatHistory = new CosmosDBChatMessageHistory({
    sessionId: chatThread.id,
    userId: userId,
  });

  const history = await chatHistory.getMessages();
  const topHistory = history.slice(-30);

  // 関連文書の検索と有効な文書の抽出
  const searchResults = await findRelevantDocuments(lastHumanMessage.content, id);
  const validDocuments = searchResults.filter(doc => 
    doc.source?.trim() && 
    doc.pageContent?.trim() &&
    doc.id?.trim()
  );
  
  // 有効な文書があるかどうかのフラグ
  const hasValidDocs = validDocuments.length > 0;

  // コンテキストの作成（有効な文書がある場合のみ）
  const context = hasValidDocs
    ? validDocuments
        .map((doc, index) => {
          const content = doc.pageContent.replace(/(\r\n|\n|\r)/gm, " ").trim();
          return `[${index + 1}] 文書名: ${doc.source}\n文書ID: ${doc.id}\n内容: ${content}`;
        })
        .join("\n\n")
    : "";

  try {
    const response = await openAI.chat.completions.create({
      messages: [
        {
          role: "system",
          content: hasValidDocs ? DOCS_SYSTEM_PROMPT : NO_DOCS_SYSTEM_PROMPT,
        },
        ...topHistory,
        {
          role: "user",
          content: hasValidDocs 
            ? constructDocsPrompt(context, lastHumanMessage.content)
            : constructNoDocsPrompt(lastHumanMessage.content),
        },
      ],
      model: chatAPIModel,
      stream: true,
      temperature: 0.7,  // より決定論的な応答のために温度を下げる
      presence_penalty: -0.5,  // 余分な情報の生成を抑制
    });

    const stream = OpenAIStream(response, {
      async onCompletion(completion) {
        // ユーザーメッセージの保存
        await chatHistory.addMessage({
          content: lastHumanMessage.content,
          role: "user",
        });

        // アシスタントの応答の保存
        await chatHistory.addMessage(
          {
            content: completion,
            role: "assistant",
          },
          hasValidDocs ? context : ""  // コンテキストは文書がある場合のみ保存
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

const findRelevantDocuments = async (query: string, chatThreadId: string) => {
  const relevantDocuments = await similaritySearchVectorWithScore(query, 10, {
    filter: `user eq '${await userHashedId()}' and chatThreadId eq '${chatThreadId}' and chatType eq 'data'`,
  });
  return relevantDocuments;
};