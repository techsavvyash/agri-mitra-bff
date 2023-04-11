import { Module } from '@nestjs/common';
import { AppController } from './app.controller';
import { AppService } from './app.service';
import { ServiceInvokerModule } from './modules/service-invoker/service-invoker.module';
import { ConfigParserModule } from './modules/config-parser/config-parser.module';
import { PrismaService } from './global-services/prisma.service';

@Module({
  imports: [ServiceInvokerModule, ConfigParserModule],
  controllers: [AppController],
  providers: [AppService,PrismaService],
})
export class AppModule {}
