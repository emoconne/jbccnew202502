import { userHashedId } from "@/features/auth/helpers";
import { OpenAIInstance } from "@/features/common/openai";
import { OpenAIStream, StreamingTextResponse } from "ai";
import { initAndGuardChatSession } from "./chat-thread-service";
import { CosmosDBChatMessageHistory } from "./cosmosdb/cosmosdb";
import { BingSearchResult } from "./Azure-bing-search/bing";
import { PromptGPTProps } from "./models";
import puppeteer, { Browser } from "puppeteer";

export const ChatAPIWeb = async (props: PromptGPTProps) => {
  let browser: Browser | undefined;
  
  try {
    // Destructure and initialize variables
    const { lastHumanMessage, chatThread } = await initAndGuardChatSession(props);
    const openAI = OpenAIInstance();
    const userId = await userHashedId();

    // Initialize chat history
    const chatHistory = new CosmosDBChatMessageHistory({
      sessionId: chatThread.id,
      userId: userId,
    });

    // Get recent chat history
    const history = await chatHistory.getMessages();
    const topHistory = history.slice(-50);

    // Step 1: Analyze user intent based on conversation history
    const intentAnalysisResponse = await openAI.chat.completions.create({
      messages: [
        {
          role: "system",
          content: `あなたはユーザーの意図分析の専門家です。
会話の履歴とユーザーの最新の質問から、ユーザーが本当に知りたいことを分析してください。
以下の点を分析結果に含めてください：
1. ユーザーの本質的な質問や関心事
2. 時間的な制約があるか（最新情報を求めているか、特定の時期の情報を求めているか）
3. ユーザーが明示的に言及していない可能性のある重要な文脈
4. 回答に含めるべき重要な情報の種類

分析は簡潔に、JSON形式で返してください：
{
  "coreQuestion": "ユーザーの本質的な質問",
  "timeContext": "最新 | 特定時期（具体的に） | 時間指定なし",
  "specificYear": "YYYY（指定されている場合のみ）", 
  "implicitContext": "暗黙的な文脈",
  "keyInformationNeeded": ["情報1", "情報2", ...]
}`
        },
        ...topHistory,
        {
          role: "user",
          content: `これまでの会話履歴と最新の質問から、ユーザーの真の意図を分析してください。
最新の質問: ${lastHumanMessage.content}`
        }
      ],
      model: "gpt-4o-mini",
      max_tokens: 500,
      temperature: 0.3
    });

    // Parse the intent analysis (handle potential JSON parsing errors)
    let intentAnalysis = {
      coreQuestion: "",
      timeContext: "最新",
      specificYear: "",
      implicitContext: "",
      keyInformationNeeded: []
    };
    
    try {
      // GPTの出力がJSONでない可能性があるため、try-catchで囲む
      const responseContent = intentAnalysisResponse.choices[0]?.message?.content || '{}';
      // JSON形式でない場合、テキスト形式で返ってくる可能性がある
      if (responseContent.trim().startsWith('{')) {
        intentAnalysis = { ...intentAnalysis, ...JSON.parse(responseContent) };
      } else {
        console.log('Non-JSON response received, using default intent analysis');
      }
    } catch (error) {
      console.error('Error parsing intent analysis JSON:', error);
    }
    
    console.log('User intent analysis:', intentAnalysis);

    // Step 2: Generate optimized search query with time context
    const searchQueryResponse = await openAI.chat.completions.create({
      messages: [
        {
          role: "system",
          content: `あなたは検索クエリ生成の専門家です。
ユーザーの質問と会話の文脈から、最適な検索クエリを生成してください。
以下の点に注意してください：
1. 会話の文脈を考慮し、前の質問と関連する情報も含めてください
2. 企業名、人名、数値などの具体的な情報は必ず含めてください
3. 日本語で検索するため、重要なキーワードは日本語で出力してください
4. 検索クエリはシンプルで簡潔にしてください
5. 特に日付の指定がない場合は、「最新」「最新情報」「2025年」「2024年」など時間的な制約を明示的に含めて最新の情報が得られるようにしてください
6. ユーザーが特定の時期（例：2020年時点）について質問している場合は、その時期を検索クエリに含めてください
7. 検索エンジンの最適化のため、日付指定は「2025年 最新」のように検索クエリの中に含めてください
8. 検索クエリのみを出力してください（説明は不要です）`
        },
        ...topHistory,
        {
          role: "user",
          content: `これまでの会話履歴と最新の質問、および意図分析から、最適な検索クエリを生成してください。
最新の質問: ${lastHumanMessage.content}
意図分析: ${JSON.stringify(intentAnalysis)}`
        }
      ],
      model: "gpt-4o-mini",
      max_tokens: 100,
      temperature: 0.3
    });

    const searchQuery = searchQueryResponse.choices[0]?.message?.content || lastHumanMessage.content;
    console.log('Generated search query:', searchQuery);

    // Initialize Bing Search with error handling
    const bing = new BingSearchResult();
    let webSearchContent = '';

    try {
      // Add search options to prioritize fresh content if not seeking historical info
      const searchOptions: any = {};
      
      if (intentAnalysis.timeContext === "最新" || !intentAnalysis.specificYear) {
        searchOptions.freshness = "Day"; // Options: Day, Week, Month
      }
      
      // APIのシグネチャに合わせて適切に検索オプションを渡す
      // 注意: BingSearchResultクラスの実装によって適切な方法が異なります
      // 引数が1つしか受け付けない場合、検索クエリに時間情報を含める方式に切り替え
      const searchResult = await bing.SearchWeb(searchQuery);
      
      if (searchResult?.webPages?.value) {
        // Initialize browser only if we have search results
        browser = await puppeteer.launch({
          headless: true,
          args: [
            '--no-sandbox',
            '--disable-setuid-sandbox',
            '--disable-dev-shm-usage',
            '--disable-gpu',
            '--no-first-run',
            '--no-zygote',
            '--single-process',
            '--disable-extensions'
          ],
          ignoreHTTPSErrors: true,
          timeout: 30000
        });

        // Process web pages
        const webPageContents = await Promise.all(
          searchResult.webPages.value.slice(0, 5).map(async (page: any) => {
            let pageInstance = null;
            try {
              if (!browser) {
                throw new Error('Browser instance not initialized');
              }
              
              pageInstance = await browser.newPage();
              await pageInstance.setDefaultNavigationTimeout(15000);
              
              await pageInstance.setViewport({
                width: 1280,
                height: 800
              });

              const response = await pageInstance.goto(page.url, {
                waitUntil: 'domcontentloaded',
                timeout: 15000
              });

              if (!response || !response.ok()) {
                throw new Error(`Failed to load page: ${page.url}`);
              }

              // Extract publication date if available
              const publicationDate = await pageInstance.evaluate(() => {
                // Common date selectors
                const dateSelectors = [
                  'time',
                  '[datetime]',
                  '[itemprop="datePublished"]',
                  '[itemprop="dateModified"]',
                  '.date',
                  '.published',
                  '.byline time',
                  '.post-date',
                  'meta[property="article:published_time"]',
                  'meta[name="pubdate"]'
                ];

                for (const selector of dateSelectors) {
                  const element = document.querySelector(selector);
                  if (element) {
                    // Check for datetime attribute
                    const dateAttr = element.getAttribute('datetime') || 
                                     element.getAttribute('content') || 
                                     element.textContent;
                    if (dateAttr && dateAttr.trim()) {
                      return dateAttr.trim();
                    }
                  }
                }
                return null;
              });

              const pageText = await pageInstance.evaluate(() => {
                const removeElements = (selector: string) => {
                  document.querySelectorAll(selector).forEach(el => el.remove());
                };

                ['script', 'style', 'nav', 'header', 'footer', 'iframe', 'noscript'].forEach(removeElements);

                const contentSelectors = [
                  'main',
                  'article',
                  '[role="main"]',
                  '#main-content',
                  '.main-content',
                  '.content',
                  'body'
                ];

                for (const selector of contentSelectors) {
                  const element = document.querySelector(selector);
                  if (element?.textContent?.trim()) {
                    return element.textContent.trim();
                  }
                }

                return document.body.textContent?.trim() || '';
              });

              const cleanUrl = new URL(page.url).toString();
              return {
                url: cleanUrl,
                title: page.name || '',
                snippet: page.snippet || '',
                content: (pageText || '').substring(0, 2000),
                publicationDate: publicationDate
              };
            } catch (error) {
              console.error(`Error scraping ${page.url}:`, error);
              return {
                url: page.url,
                title: page.name || '',
                snippet: page.snippet || '',
                content: page.snippet || '',
                publicationDate: null
              };
            } finally {
              if (pageInstance) {
                await pageInstance.close().catch(console.error);
              }
            }
          })
        );

        // Format web search content if we have results
        webSearchContent = `
使用した検索クエリ: "${searchQuery}"

Web検索結果の概要:
${webPageContents.map(page => `
タイトル: ${page.title}
URL: [${page.url}](${page.url})
${page.publicationDate ? `公開日時: ${page.publicationDate}` : ''}
スニペット: ${page.snippet}

詳細コンテンツ抜粋:
${page.content}
`).join("\n\n")}`;
      }
    } catch (error) {
      console.warn('Web search failed:', error);
      webSearchContent = '\nWeb検索結果はありませんでした。既存の知識ベースに基づいて回答いたします。';
    }

    // Add user message to chat history
    await chatHistory.addMessage({
      content: lastHumanMessage.content,
      role: "user"
    });

    // Construct prompt with intent analysis and search results
    const prompt = `
以前の会話の文脈:
${topHistory.map(msg => `${msg.role}: ${msg.content}`).join("\n")}

最新の問い合わせ: ${lastHumanMessage.content}

ユーザー意図の分析:
- 本質的な質問: ${intentAnalysis.coreQuestion || '明示的に示されていません'}
- 時間的文脈: ${intentAnalysis.timeContext || '指定なし'}
${intentAnalysis.specificYear ? `- 指定された年: ${intentAnalysis.specificYear}` : ''}
- 暗黙的な文脈: ${intentAnalysis.implicitContext || 'なし'}
- 求められている情報: ${(intentAnalysis.keyInformationNeeded || []).join(', ')}

${webSearchContent}

上記の会話の文脈、ユーザー意図分析${webSearchContent ? 'と検索結果' : ''}を踏まえて、最新の質問に対して包括的かつ情報豊富な回答を生成してください。
${webSearchContent ? `
以下の形式でMarkdown形式の参考文献リストを必ず含めてください:

### 参考文献
- [タイトル1](URL1)
- [タイトル2](URL2)
` : ''}`;

    // Create OpenAI chat completion
    const response = await openAI.chat.completions.create({
      messages: [
        {
          role: "system",
          content: `あなたは ${process.env.NEXT_PUBLIC_AI_NAME} です。ユーザーからの質問に対して日本語で丁寧に回答します。以下の指示に従ってください：

1. 質問には会話の文脈とユーザーの真の意図を考慮しながら、正直かつ正確に答えてください。
2. Web検索結果がある場合はそれを参考にしつつ、信頼性の高い情報を提供してください。
3. 情報の時間的な文脈を常に意識し、最新情報か特定時期の情報かを明示してください。
4. Web検索結果の公開日時が提供されている場合は、その情報の鮮度も考慮してください。
5. ユーザーが特定の時期について質問している場合を除き、最新の情報を優先して提供してください。
6. Web検索結果がある場合は、回答の最後に「### 参考文献」という見出しを付け、その後に参照元を以下のMarkdown形式で列挙してください：
   - [タイトルテキスト](URL)
   - [タイトルテキスト](URL)
7. 以前の会話内容と矛盾する情報を提供しないように注意してください。
8. HTMLタグは一切使用せず、必ずMarkdown記法を使用してください。`
        },
        ...topHistory,
        {
          role: "user",
          content: prompt
        }
      ],
      model: "gpt-4o-mini",
      stream: true,
      max_tokens: 4000,
      temperature: 0.7
    });

    // Stream the response
    const stream = OpenAIStream(response, {
      async onCompletion(completion) {
        await chatHistory.addMessage({
          content: completion,
          role: "assistant"
        });
      }
    });

    return new StreamingTextResponse(stream);

  } catch (error) {
    console.error('ChatAPIWeb error:', error);
    return new Response(
      error instanceof Error ? error.message : "An unknown error occurred.",
      {
        status: 500,
        statusText: error instanceof Error ? error.toString() : "Unknown Error"
      }
    );
  } finally {
    if (browser) {
      try {
        await browser.close();
      } catch (error) {
        console.error('Error closing browser:', error);
      }
    }
  }
};