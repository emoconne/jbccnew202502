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
- 引用のNAMEには文書名を、IDには文書IDを正確に入れてください
- 回答内にHTMLリンク（<a href>タグ）がある場合はMarkdownリンク形式 [テキスト](URL) に変換してください
----------------
context:
${context}
----------------
question: ${userQuestion}
`, 'utf-8').toString();
};

// 曖昧なプロンプトを検出し、検索クエリを生成するためのプロンプト
const QUERY_GENERATION_PROMPT = Buffer.from(`
あなたは検索クエリ最適化の専門家です。ユーザーの質問から、関連文書を検索するための最適なクエリを生成してください。
- 質問が曖昧な場合は、より具体的で検索に適したクエリを生成してください。
- 質問が具体的な場合は、そのまま使用してください。
- 検索クエリは簡潔で、重要なキーワードを含むものにしてください。
- 検索クエリのみを返してください。余分な説明は不要です。
- 検索の際には、有給休暇を有給など短縮する場合があります。一般的な類義語を想定して加えてください
`, 'utf-8').toString();

// HTMLタグをMarkdownに変換する関数
const convertHtmlToMarkdown = (text: string): string => {
  // <a href="URL">テキスト</a> 形式のリンクをMarkdown [テキスト](URL) に変換
  return text.replace(/<a\s+href="([^"]+)"[^>]*>([^<]+)<\/a>/g, '[$2]($1)');
};

export const ChatAPIDoc = async (props: PromptGPTProps) => {
  const { lastHumanMessage, id, chatThread } = await initAndGuardChatSession(
    props
  );

  const openAI = OpenAIInstance();
  const userId = await userHashedId();

  // モデル選択のロジックを簡略化
  const chatAPIModel =  "gpt-4o-mini"

  const chatDoc = props.chatDoc;

  const chatHistory = new CosmosDBChatMessageHistory({
    sessionId: chatThread.id,
    userId: userId,
  });

  const history = await chatHistory.getMessages();
  // より多くの履歴を保持（GPT-4oの高いトークン上限を活用）
  const topHistory = history.slice(-50); 

  // ユーザープロンプトが曖昧かどうかを判断し、最適なクエリを生成
  let searchQuery = lastHumanMessage.content;
  
  if (searchQuery.length < 10 || !searchQuery.includes("?")) {
    // プロンプトが短すぎる、または疑問符がない場合は曖昧と判断
    try {
      const queryGeneration = await openAI.chat.completions.create({
        messages: [
          {
            role: "system",
            content: QUERY_GENERATION_PROMPT,
          },
          {
            role: "user",
            content: lastHumanMessage.content,
          },
        ],
        model: chatAPIModel,
        temperature: 0.3,
        max_tokens: 100,
      });
      
      // 生成されたクエリを使用
      if (queryGeneration.choices[0]?.message?.content) {
        searchQuery = queryGeneration.choices[0].message.content.trim();
      }
    } catch (error) {
      console.error("Query generation failed, using original query:", error);
      // エラーが発生した場合は元のクエリを使用
    }
  }

  const relevantDocuments = await findRelevantDocuments(
    searchQuery,
    chatDoc
  );

  // ドキュメントのコンテキスト作成時にエンコーディングを考慮
  const context = relevantDocuments
    .map((result, index) => {
      const content = Buffer.from(result.pageContent, 'utf-8')
        .toString()
        .replace(/(\r\n|\n|\r)/gm, "");
      
      // 「よくある質問：」の文言を削除し、インデックス番号は残す
      return Buffer.from(
        `[${index}]. ${result.source}\nfile id: ${result.id}\n${content}`,
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
      max_tokens: 4000, // GPT-4oの高いトークン上限を活用
    });

    const stream = OpenAIStream(response, {
      async onCompletion(completion) {
        // HTMLタグをMarkdownに変換
        const formattedCompletion = convertHtmlToMarkdown(completion);
        
        // 履歴保存時もエンコーディングを考慮
        await chatHistory.addMessage({
          content: Buffer.from(lastHumanMessage.content, 'utf-8').toString(),
          role: "user",
        });

        await chatHistory.addMessage(
          {
            content: Buffer.from(formattedCompletion, 'utf-8').toString(),
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
    : `chatType eq 'doc' and deptName eq '${chatDoc}'`;

  return await similaritySearchVectorWithScore(query, 10, {
    filter: filter,
  });
};