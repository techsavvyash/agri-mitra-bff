import { Controller, Get, Post, Headers, Body, UseInterceptors, Param, UnsupportedMediaTypeException } from "@nestjs/common";
import { AppService, Prompt } from "./app.service";
import { AlertInterceptor } from "./modules/alerts/alerts.interceptor";
import { IsNotEmpty,IsUUID, IsOptional } from 'class-validator';
import { interpret } from "xstate";
import { botFlowMachine } from "./xstate/prompt/prompt.machine";
import { Language } from "./language";
import { ConfigService } from "@nestjs/config";
import { AiToolsService } from "./modules/aiTools/ai-tools.service";

export class PromptDto {
  @IsNotEmpty()
  type: "Text"|"Audio" ;
  @IsNotEmpty()
  text: string;
  @IsNotEmpty()
  @IsUUID()
  userId: string;


  @IsOptional()
  inputLanguage?: string;
  @IsOptional()
  media?: string;
  @IsOptional()
  appId?: string;
  @IsOptional()
  channel?: string;
  @IsOptional()
  @IsUUID()
  from?: string;
  @IsOptional()
  context?: string;
  @IsOptional()
  to?: string;
  @IsOptional()
  @IsUUID()
  messageId?: string;
  @IsOptional()
  @IsUUID()
  conversationId?: string;
  @IsOptional()
  identifier?: string;
}

const conversationMap = new Map<string, any>();

@Controller()
export class AppController {
  private configService : ConfigService
  private aiToolsService: AiToolsService
  
  constructor(
    private readonly appService: AppService
  ) {
    this.configService = new ConfigService()
    this.aiToolsService = new AiToolsService(this.configService)
  }

  @Get("/")
  getHello(): string {
    return this.appService.getHello();
  }

  @UseInterceptors(AlertInterceptor)
  @Post("/prompt")
  async prompt(@Body() promptDto: any, @Headers() headers): Promise<any> {
    const userId = headers["user-id"]
    let prompt: Prompt = {
      input: promptDto
    }
    let userInput = promptDto.text;

    if(promptDto.text){
      if(/^\d+$/.test(userInput)){
        prompt.inputLanguage = Language.en
      } else {
        let response = await this.aiToolsService.detectLanguage(userInput)
        prompt.inputLanguage = response["language"] as Language
      }
    } else if (promptDto.media){
      if(promptDto.media.category=="base64audio" && promptDto.media.text){
        prompt.inputLanguage = promptDto.inputLanguage as Language
        let response = await this.aiToolsService.speechToText(promptDto.media.text,prompt.inputLanguage)
        userInput = response["data"]["source"]
        console.log(userInput)
      } else {
        return {
          text: "",
          media: promptDto.media,
          mediaCaption: "",
          error: "Unsupported media"
        }
      }
    }

    if(prompt.inputLanguage != Language.en) {
      try {
        let response = await this.aiToolsService.translate(
          promptDto.inputLanguage as Language,
          Language.en,
          userInput
        )
        prompt.inputTextInEnglish = response["translated"]
      } catch(error){
        console.log(error)
        return { error: "unable to translate given language" }
      }
    } else {
      prompt.inputTextInEnglish = userInput
    }

    let botFlowService = conversationMap.get(userId);
    if (!botFlowService) {
      // Create a new bot flow service for a new conversation
      const newBotFlowService = interpret(botFlowMachine.withContext({
        query: '',
        queryType: '',
        response: '',
        userAadhaarNumber: '',
        otp: '',
        userData: null,
        error: '',
        currentState: "getUserQuestion",
        type: '',
        inputLanguage: prompt.inputLanguage
      })).start();
      conversationMap.set(userId, newBotFlowService);
      botFlowService = newBotFlowService;
    }

    // Send the user's question as a USER_INPUT event to the bot flow machine
    botFlowService.send('USER_INPUT', { data: prompt.inputTextInEnglish });
    await new Promise((resolve) => {
      botFlowService.subscribe((state) => {
        console.log('Current state:', state.value);
        console.log('Current context:', state.context);
        if(state.context.type=="pause") resolve(state)
      });
      botFlowService.onDone((state)=>{
        resolve(state)
      })
    });
    console.log(botFlowService.getSnapshot().context.response)
    let result = {
      text: botFlowService.getSnapshot().context.response,
      error: null
    }
    if(botFlowService.getSnapshot().context.error){
      conversationMap.delete(userId)
      result.text = null,
      result.error = botFlowService.getSnapshot().context.error
    }
    prompt.inputLanguage = botFlowService.getSnapshot().context.inputLanguage
    if(prompt.inputLanguage != Language.en) {
      try {
        let response = await this.aiToolsService.translate(
          Language.en,
          prompt.inputLanguage as Language,
          result.text
        )
        if(response["error"])
        result.error = "unable to translate given language"
        result.text = response["translated"]
      } catch(error){
        console.log(error)
        return { error: "unable to translate given language" }
      }
    }

    return result;
  }
}
