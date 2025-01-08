import { userHashedId } from "@/features/auth/helpers";
import { OpenAIInstance } from "@/features/common/openai";
import { OpenAIStream, StreamingTextResponse } from "ai";
import { initAndGuardChatSession } from "./chat-thread-service";
import { CosmosDBChatMessageHistory } from "./cosmosdb/cosmosdb";
import { BingSearchResult } from "./Azure-bing-search/bing";
import { PromptGPTProps } from "./models";
import puppeteer from "puppeteer";

export const ChatAPIWeb = async (props: PromptGPTProps) => {
  // Destructure and initialize variables
  const { lastHumanMessage, chatThread } = await initAndGuardChatSession(props);
  const openAI = OpenAIInstance();
  const userId = await userHashedId();

  // Select appropriate model
  let chatAPIModel =
    props.chatAPIModel === "GPT-3" ? "gpt-35-turbo-16k" : "gpt-4o-mini";

  // Initialize chat history first to use in search context
  const chatHistory = new CosmosDBChatMessageHistory({
    sessionId: chatThread.id,
    userId: userId,
  });

  // Get recent chat history before adding new message
  const history = await chatHistory.getMessages();
  const topHistory = history.slice(history.length - 30, history.length);

  // Initialize Bing Search with context from recent messages
  const bing = new BingSearchResult();
  const searchContext = topHistory
    .slice(-3)
    .map((msg) => msg.content)
    .join(" ");
  const searchResult = await bing.SearchWeb(
    `${searchContext} ${lastHumanMessage.content}`
  );

  // Enhanced web page content extraction with proper URL handling
  const webPageContents = await Promise.all(
    searchResult.webPages.value.slice(0, 5).map(async (page: any) => {
      try {
        const browser = await puppeteer.launch({ headless: true });
        const pageInstance = await browser.newPage();
        await pageInstance.goto(page.url, {
          waitUntil: "networkidle0",
          timeout: 30000,
        });

        // Extract main content with improved selection
        const pageText = await pageInstance.evaluate(() => {
          const removeElements = (selector: string) => {
            document.querySelectorAll(selector).forEach((el) => el.remove());
          };

          // Remove non-content elements
          removeElements("script");
          removeElements("style");
          removeElements("nav");
          removeElements("header");
          removeElements("footer");

          // Try to extract main content with fallbacks
          const contentSelectors = [
            "main",
            "article",
            '[role="main"]',
            "#main-content",
            ".main-content",
            ".content",
            "body",
          ];

          for (const selector of contentSelectors) {
            const element = document.querySelector(selector);
            if ((element as HTMLElement)?.innerText) {
              return (element as HTMLElement).innerText;
            }
          }

          return document.body.innerText;
        });

        await browser.close();

        // Ensure URL is properly encoded
        const cleanUrl = new URL(page.url).toString();

        return {
          url: cleanUrl,
          title: page.name,
          snippet: page.snippet,
          content: pageText.substring(0, 2000),
        };
      } catch (error) {
        console.error(`Error scraping ${page.url}:`, error);
        return {
          url: page.url,
          title: page.name,
          snippet: page.snippet,
          content: page.snippet,
        };
      }
    })
  );

  // Add user message to chat history after search
  await chatHistory.addMessage({
    content: lastHumanMessage.content,
    role: "user",
  });

  // Construct comprehensive prompt with conversation context
  const Prompt = `
以前の会話の文脈:
${topHistory.map((msg) => `${msg.role}: ${msg.content}`).join("\n")}

最新の問い合わせ: ${lastHumanMessage.content}

Web検索結果の概要:
${webPageContents
  .map(
    (page) => `
タイトル: ${page.title}
URL: [${page.url}](${page.url})
スニペット: ${page.snippet}

詳細コンテンツ抜粋:
${page.content.substring(0, 500)}...
`
  )
  .join("\n\n")}

上記の会話の文脈と検索結果を踏まえて、最新の質問に対して包括的かつ情報豊富な回答を生成してください。

以下の形式でMarkdown形式の参考文献リストを必ず含めてください:

### 参考文献
- [タイトル1](URL1)
- [タイトル2](URL2)
`;

  try {
    // Create OpenAI chat completion with conversation history
    const response = await openAI.chat.completions.create({
      messages: [
        {
          role: "system",
          content: `あなたは ${process.env.NEXT_PUBLIC_AI_NAME} です。ユーザーからの質問に対して日本語で丁寧に回答します。以下の指示に従ってください：

1. 質問には会話の文脈を考慮しながら、正直かつ正確に答えてください。

2. Web検索結果を参考にしつつ、信頼性の高い情報を提供してください。

3. 回答の最後には必ず「### 参考文献」という見出しを付け、その後に参照元を以下のMarkdown形式で列挙してください：
   - [タイトルテキスト](URL)
   - [タイトルテキスト](URL)

4. 以前の会話内容と矛盾する情報を提供しないように注意してください。

5. HTMLタグは一切使用せず、必ずMarkdown記法を使用してください。`,
        },
        ...topHistory,
        {
          role: "user",
          content: Prompt,
        },
      ],
      model: chatAPIModel,
      stream: true,
      max_tokens: 2000,
      temperature: 0.7,
    });

    // Stream the response
    const stream = OpenAIStream(response, {
      async onCompletion(completion) {
        await chatHistory.addMessage({
          content: completion,
          role: "assistant",
        });
      },
    });

    return new StreamingTextResponse(stream);
  } catch (e: unknown) {
    if (e instanceof Error) {
      return new Response(e.message, {
        status: 500,
        statusText: e.toString(),
      });
    } else {
      return new Response("An unknown error occurred.", {
        status: 500,
        statusText: "Unknown Error",
      });
    }
  }
};