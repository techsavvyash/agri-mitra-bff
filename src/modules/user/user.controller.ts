import { Controller, Get, Param, Query, Request, UseGuards } from '@nestjs/common';
import { UserService } from './user.service';
import { query } from '@prisma/client';
import { AuthGuard } from '../../common/auth-gaurd';
import { ConfigService } from '@nestjs/config';
import { CustomLogger } from 'src/common/logger';

@Controller('user')
@UseGuards(AuthGuard)
export class UserController {
  private logger: CustomLogger;
  constructor(
    private readonly userService: UserService,
    private readonly configService: ConfigService
  ) {
    this.logger = new CustomLogger("UserService");
  }

  @Get("/conversations")
  async conversations(
    @Request() request, 
    @Query('userid') adminUserId: string, 
    @Query('page') page: number, 
    @Query('perPage') perPage: number,
    @Query('mobileNumber') mobileNumber: string,
    @Query('fromDate') fromDate: string,
    @Query('toDate') toDate: string
  ): Promise<query[]> {
    let userId = null
    if(request.headers.roles.indexOf('Admin') != -1) {
      userId = adminUserId
      if(!userId && mobileNumber) {
        var myHeaders = new Headers();
        myHeaders.append("x-application-id", this.configService.get("FRONTEND_APPLICATION_ID"));
        myHeaders.append("Authorization", this.configService.get('FUSION_AUTH_API_KEY'));

        var requestOptions: RequestInit = {
          method: 'GET',
          headers: myHeaders,
          redirect: 'follow'
        };
        try{
          let res: any = await fetch(`${this.configService.get('FUSION_AUTH_BASE_URL')}api/user?username=${mobileNumber}`, requestOptions)
          res = await res.json()
          userId = res.user.id
        } catch(error) {
          this.logger.error(error)
        }
      }
    } else {
      userId = request.headers.userId
    }
    page = page?page:1
    perPage = perPage?perPage:10
    return this.userService.conversationsList(
      userId,
      parseInt(`${page}`),
      parseInt(`${perPage}`),
      fromDate,
      toDate
    );
  }

  @Get("/chathistory/:conversationId")
  async chatHistory(@Param("conversationId") conversationId: string, @Request() request, @Query('userid') adminUserId: string): Promise<query[]> {
    let userId = request.headers.userId
    if(request.headers.roles.indexOf('Admin') != -1) {
      userId = adminUserId
    }
    return this.userService.conversationHistory(conversationId,userId);
  }

  @Get("conversations/delete/:conversationId")
  async deleteConversation(@Param("conversationId") conversationId: string, @Request() request): Promise<boolean> {
    const userId = request.headers.userId
    return this.userService.deleteConversation(conversationId,userId)
  }

  @Get("/error/:aadharId")
  async getErrorCode(@Param("aadharId") aadharId: string) {
    const errors = [
      { id: 1, error: "Account number is not Correct" },
      { id: 2, error: "Gender is not correct" },
      { id: 3, error: "Installment not received" },
      { id: 4, error: "Online Application is pending for Approval" },
      { id: 5, error: "Payment Related" },
      { id: 6, error: "Problem in Adhaar Correction" },
      { id: 7, error: "Problem in bio-metric based e-kyc" },
      { id: 8, error: "Problem in OTP based e-kyc" },
      { id: 9, error: "Transaction Failed" }
    ];
    
    const randomError = errors[Math.floor(Math.random() * errors.length)];
    return randomError
  }
}