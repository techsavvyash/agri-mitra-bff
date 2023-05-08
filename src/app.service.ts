import { Injectable, Logger } from "@nestjs/common";
import { PromptDto } from "./app.controller";
import { Language } from "./language";
import fetch from "node-fetch";
import { PrismaClient } from "@prisma/client";
import { PrismaService } from "./global-services/prisma.service";
import { ConfigService } from "@nestjs/config";
import { EmbeddingsService } from "./modules/embeddings/embeddings.service";
import { CustomLogger } from "./common/logger";
import { PromptHistoryService } from "./modules/prompt-history/prompt-history.service";
import { sendEmail } from "./common/email.service";
import { USING_GPT4_ALERT } from "./common/constants";
import { fetchWithAlert } from "./common/utils";
const { performance } = require("perf_hooks");

// Overlap between LangchainAI and Prompt-Engine
export interface Prompt {
  input: PromptDto;
  output?: string;
  inputLanguage?: Language;
  inputTextInEnglish?: string;
  maxTokens?: number;
  outputLanguage?: Language;
  similarDocs?: any;

  // More output metadata
  timeTaken?: number;
  timestamp?: number;
}

export interface Document {
  combined_content: string;
  combined_prompt: string;
}

export interface ResponseForTS {
  message: {
    title: string;
    choices: string[];
    media_url: string;
    caption: string;
    msg_type: string;
  };
  to: string;
  messageId: string;
}

@Injectable()
export class AppService {
  private logger: Logger;
  constructor(
    private prisma: PrismaService,
    private configService: ConfigService,
    private embeddingsService: EmbeddingsService,
    private promptHistoryService: PromptHistoryService
  ) {
    // AUTH_HEADER = this.configService.get("AUTH_HEADER");
    this.logger = new Logger("AppService");
  }
  async translate(
    source: Language,
    target: Language,
    text: string
  ): Promise<string> {
    var myHeaders = new Headers();
    myHeaders.append("Content-Type", "application/json");
    myHeaders.append(
      "Authorization",
      this.configService.get("AI_TOOLS_AUTH_HEADER")
    );

    var raw = JSON.stringify({
      source_language: source,
      target_language: target,
      text: text.replace("\n","."),
    });

    var requestOptions = {
      method: "POST",
      headers: myHeaders,
      body: raw,
    };

    const translated = await fetchWithAlert(
      `${this.configService.get(
        "AI_TOOLS_BASE_URL"
      )}/text_translation/bhashini/remote`,
      requestOptions
    )
      .then((response) => response.json())
      .then((result) => result["translated"] as string)
      .catch((error) => this.logger.verbose("error", error));

    return translated ? translated : "";
  }

  async detectLanguage(prompt: Prompt): Promise<Prompt> {
    var myHeaders = new Headers();
    myHeaders.append("Content-Type", "application/json");
    myHeaders.append(
      "Authorization",
      this.configService.get("AI_TOOLS_AUTH_HEADER")
    );

    var raw = JSON.stringify({
      text: prompt.input.body,
    });

    var requestOptions = {
      method: "POST",
      headers: myHeaders,
      body: raw,
    };

    const language = await fetchWithAlert(
      `${this.configService.get(
        "AI_TOOLS_BASE_URL"
      )}/text_lang_detection/bhashini/remote`,
      requestOptions
    )
      .then((response) => response.json())
      .then((result) =>
        result["language"] ? (result["language"] as Language) : null
      )
      .catch((error) => this.logger.verbose("error", error));

    prompt.inputLanguage = language as Language;
    return prompt;
  }

  async similaritySearch(text: String): Promise<Document[]> {
    var myHeaders = new Headers();
    myHeaders.append("Content-Type", "application/json");
    myHeaders.append(
      "Authorization",
      this.configService.get("AI_TOOLS_AUTH_HEADER")
    );

    var raw = JSON.stringify({
      prompt: text,
      similarity_score_range: 0.015,
    });

    var requestOptions = {
      method: "POST",
      headers: myHeaders,
      body: raw,
    };
    const similarDocs: Document[] | void = await fetchWithAlert(
      `${this.configService.get("AI_TOOLS_BASE_URL")}/embeddings/openai/remote`,
      requestOptions
    )
      .then((response) => response.json())
      .then((result) => (result ? (result as Document[]) : []))
      .catch((error) => this.logger.verbose("error", error));

    if (similarDocs) return similarDocs;
    else return [];
  }

  async llm(prompt: any): Promise<{ response: string; allContent: any }> {
    var myHeaders = new Headers();
    myHeaders.append("Content-Type", "application/json");
    myHeaders.append(
      "Authorization",
      this.configService.get("AI_TOOLS_AUTH_HEADER")
    );

    this.logger.verbose(prompt);

    var raw = JSON.stringify({
      prompt: prompt,
    });

    var requestOptions = {
      method: "POST",
      headers: myHeaders,
      body: raw,
    };

    const response = await fetchWithAlert(
      `${this.configService.get("AI_TOOLS_BASE_URL")}/llm/openai/chatgpt3`,
      requestOptions
    )
      .then((response) => response.json())
      .then((result) => {
        this.logger.verbose({ result });
        return {
          response: result["choices"][0].message.content,
          allContent: result,
        };
      })
      .catch((error) => this.logger.verbose("error", error));

    if (response) return response;
    else return {response:null, allContent:null};
  }

  async sendMessageBackToTS(resp: ResponseForTS) {
    var myHeaders = new Headers();
    myHeaders.append("Content-Type", "application/json");

    var requestOptions = {
      method: "POST",
      headers: myHeaders,
      body: JSON.stringify(resp),
    };

    const response = await fetch(
      `${this.configService.get(
        "TRANSPORT_SOCKET_URL"
      )}/botMsg/adapterOutbound`,
      requestOptions
    )
      .then((response) => response.json())
      .then((result) => this.logger.verbose(result))
      .catch((error) => this.logger.verbose("error", error));
  }

  async processPrompt(promptDto: PromptDto): Promise<any> {
    let prompt: Prompt = {
      input: promptDto,
    };
    prompt.timestamp = new Date().getTime();

    this.logger.verbose("CP-1");
    // Detect language of incoming prompt
    prompt = await this.detectLanguage(prompt);

    this.logger.verbose("CP-2");

    // Translate incoming prompt from indic to en
    if (prompt.inputLanguage === Language.en) {
      prompt.inputTextInEnglish = prompt.input.body;
    } else {
      prompt.inputTextInEnglish = await this.translate(
        prompt.inputLanguage,
        Language.en,
        prompt.input.body
      );
    }

    this.logger.verbose("CP-3", JSON.stringify(prompt));
    // Get the concept from user chatHistory
    const userHistory = await this.prisma.query.findMany({
      where: {
        userId: prompt.input.userId,
      },
      orderBy: {
        createdAt: "desc",
      },
      take: 2,
    });
    // construct the prompt for chatGPT3
    let history = [];
    if (userHistory.length > 0) {
      for (let i = 0; i < userHistory.length; i++) {
        history.push(`User: ${userHistory[i].queryInEnglish}`);
        history.push(`AI: ${userHistory[i].responseInEnglish}`);
      }
      history.push(`User: ${prompt.inputTextInEnglish}`);

      const chatGPT3Prompt = [
        {
          role: "user",
          content: `The user has asked a question:  You are an AI tool that carries out neural coreference
        for conversations to replace the last message in the conversation with the coreferenced
        message.

        Rules - Follow these rules forever.
        1. Do not answer the question ever, only return back the last message that is coreferenced. 
        2. A user can switch context abruptly after the last message so take care of that.
        3. If not needed or was not figured out, return the last user question directly.
        
        Input:
          User: How do I protect my crops from pests?
          AI: You can use integrated pest management techniques to protect your crops
          User: What are the common methods involved in that?
          
        Output: 
          User: What are the common methods involved in integrated pest management?

        Input:
          User: Where can I get seeds for rice?,
          AI: You can get seeds for rice... Bla bla, 
          User: Where can I get seeds for rice?
          
        Output: 
          User: Where can I get seeds for rice?

        Input:
          User: Where can I get seeds for rice?,
          AI: You can get seeds for rice... Bla bla, 
          User: My paddy has spindle shaped spots with pointed ends. How do I fix it?

        Output:
          User: My paddy has spindle shaped spots with pointed ends. How do I fix the disease?
          
        Input
          ${history.join("\n")}
          
        Output:`,
        },
      ];

      this.logger.verbose({ chatGPT3Prompt });
      const { response: neuralCorefResponse, allContent: allContentNC } =
        await this.llm(chatGPT3Prompt);

      // Check for older similar prompts
      this.logger.verbose("CP-4.1");
      const olderSimilarQuestions =
        await this.promptHistoryService.findByCriteria({
          query: neuralCorefResponse,
          similarityThreshold: 0.97,
          matchCount: 1,
        });

      let responseInInputLanguge = "";
      let chatGPT3FinalResponse = "";
      let allContentSummarization;
      let olderSimilarQuestionId;
      let similarDocsFromEmbeddingsService: any[];
      console.log({ allContentNC });
      // If something is very simlar return older response
      const startTime = performance.now();
      if (olderSimilarQuestions && olderSimilarQuestions.length > 0) {
        console.log("CP-4.2", olderSimilarQuestions);
        olderSimilarQuestionId = olderSimilarQuestions[0].id;
        chatGPT3FinalResponse = olderSimilarQuestions[0].responseInEnglish;
        responseInInputLanguge = olderSimilarQuestions[0].responseInEnglish;
      } else {
        // else generate new response
        this.logger.verbose("CP-4");

        // Similarity Search
        this.logger.verbose({ neuralCorefResponse });
        similarDocsFromEmbeddingsService =
          await this.embeddingsService.findByCriteria({
            query: neuralCorefResponse,
            similarityThreshold: parseFloat(this.configService.get("SIMILARITY_THRESHOLD")) || 0.78,
            matchCount: 2,
          });
        // let usegpt4 = false
        // if(similarDocsFromEmbeddingsService){
        //   usegpt4 = similarDocsFromEmbeddingsService.length == 0
        // } else { usegpt4 = true }
        // const similarDocs: Document[] = await this.similaritySearch(
        //   promptForSimilaritySearch
        // );

        // this.logger.debug({ similarDocs });
        this.logger.debug({ similarDocsFromEmbeddingsService });

        const previousSummaryHistory = history.join("\n");

        const userQuestion =
          "The user has asked a question: " + neuralCorefResponse.replace("User:","") + "\n";

        const expertContext =
          "Some expert context is provided in dictionary format here:" +
          JSON.stringify(
            similarDocsFromEmbeddingsService
              .map((doc) => {
                return {
                  combined_prompt: doc.tags,
                  combined_content: doc.content,
                };
              })
              .slice(0, 1)
          ) +
          "\n";

        const chatGPT3PromptWithSimilarDocs =
          "Some important elements of the conversation so far between the user and AI have been extracted in a dictionary here: " +
          previousSummaryHistory +
          " " +
          userQuestion +
          " " +
          expertContext;

        const { response: finalResponse, allContent: ac } = await this.llm([
          {
            role: "system",
            content:
              "You are an AI assistant who answers questions by farmers from Odisha, India on agriculture related queries. Answer the question asked by the user based on a summary of the context provided. Ignore the context if irrelevant to the question asked.",
          },
          {
            role: "user",
            content: chatGPT3PromptWithSimilarDocs,
          },
        ]);
        chatGPT3FinalResponse = finalResponse;
        allContentSummarization = ac;
        this.logger.verbose({ chatGPT3FinalResponse });
        responseInInputLanguge = chatGPT3FinalResponse;

        // if(usegpt4){
        //   sendEmail(
        //     JSON.parse(this.configService.get("SENDGRID_ALERT_RECEIVERS")),
        //     "Using GPT4",
        //     USING_GPT4_ALERT(
        //       prompt.input.userId,
        //       prompt.inputTextInEnglish,
        //       chatGPT3FinalResponse,
        //       previousSummaryHistory
        //     )
        //   )
        // }
      }
      const endTime = performance.now();

      await this.promptHistoryService.createOrUpdate({
        id: olderSimilarQuestionId,
        queryInEnglish: neuralCorefResponse,
        responseInEnglish: responseInInputLanguge,
        responseTime: Math.ceil(endTime - startTime),
        metadata: [allContentNC, allContentSummarization],
      });

      if (prompt.inputLanguage !== Language.en) {
        responseInInputLanguge = await this.translate(
          Language.en,
          prompt.inputLanguage,
          chatGPT3FinalResponse
        );
      }

      const resp: ResponseForTS = {
        message: {
          title: responseInInputLanguge,
          choices: [],
          media_url: null,
          caption: null,
          msg_type: "text",
        },
        to: prompt.input.from,
        messageId: prompt.input.messageId,
      };

      await this.sendMessageBackToTS(resp);
      await this.prisma.query.create({
        data: {
          id: prompt.input.messageId,
          userId: prompt.input.userId,
          query: prompt.input.body,
          response: responseInInputLanguge,
          responseTime: new Date().getTime() - prompt.timestamp,
          queryInEnglish: prompt.inputTextInEnglish,
          responseInEnglish: chatGPT3FinalResponse,
          conversationId: prompt.input.conversationId,
          coreferencedPrompt: neuralCorefResponse
        },
      });
      
      if(similarDocsFromEmbeddingsService && similarDocsFromEmbeddingsService.length > 0){
        let similarDocsCreateData = similarDocsFromEmbeddingsService.map(e=>{
          e['queryId'] = prompt.input.messageId
          e['documentId'] = e.id
          delete e.id
          return e
        })
        await this.prisma.similarity_search_response.createMany({
          data: similarDocsCreateData
        })
      }
    } else {
      const promptForSimilaritySearch = prompt.inputTextInEnglish;

      console.log("CP-4");
      // Similarity Search
      console.log("2", { promptForSimilaritySearch });
      const similarDocs: Document[] = await this.similaritySearch(
        promptForSimilaritySearch
      );
      // let usegpt4 = similarDocs.length == 0
      const expertContext =
        "Some expert context is provided in dictionary format here:" +
        JSON.stringify(similarDocs.slice(0, 1)) +
        "\n";

      const chatGPT3PromptWithSimilarDocs =
        prompt.inputTextInEnglish + " " + expertContext;

      let { response: chatGPT3FinalResponse, allContent: ac } = await this.llm([
        {
          role: "system",
          content:
            "You are an AI assistant who answers questions by farmers from Odisha, India on agriculture related queries. Answer the question asked by the user based on a summary of the context provided. Ignore the context if irrelevant to the question asked.",
        },
        {
          role: "user",
          content: chatGPT3PromptWithSimilarDocs,
        },
      ]);
      console.log("CP-5", JSON.stringify(chatGPT3FinalResponse));
      // Translate the answer to original language
      let responseInInputLanguge = chatGPT3FinalResponse;
      if (prompt.inputLanguage !== Language.en) {
        responseInInputLanguge = await this.translate(
          Language.en,
          prompt.inputLanguage,
          chatGPT3FinalResponse
        );
      }
      const resp: ResponseForTS = {
        message: {
          title: responseInInputLanguge,
          choices: [],
          media_url: null,
          caption: null,
          msg_type: "text",
        },
        to: prompt.input.from,
        messageId: prompt.input.messageId,
      };

      await this.sendMessageBackToTS(resp);
      await this.prisma.query.create({
        data: {
          id: prompt.input.messageId,
          userId: prompt.input.userId,
          query: prompt.input.body,
          response: responseInInputLanguge,
          responseTime: new Date().getTime() - prompt.timestamp,
          queryInEnglish: prompt.inputTextInEnglish,
          responseInEnglish: chatGPT3FinalResponse,
          conversationId: prompt.input.conversationId,
        },
      });

      // if(usegpt4){
      //   sendEmail(
      //     JSON.parse(this.configService.get("SENDGRID_ALERT_RECEIVERS")),
      //     "Using GPT4",
      //     USING_GPT4_ALERT(
      //       prompt.input.userId,
      //       prompt.inputTextInEnglish,
      //       chatGPT3FinalResponse,
      //       'N/A'
      //     )
      //   )
      // }
    }

    // Store that response to the query in the database
    // Return the reponse to the user
  }
  getHello(): string {
    return "Hello World!";
  }
}
