import { Global, Module } from '@nestjs/common';
import { PrismaService } from './prisma.service';
import { DatabaseCredentialRotationService } from './database-credential-rotation.service';

@Global()
@Module({
  providers: [PrismaService, DatabaseCredentialRotationService],
  exports:   [PrismaService, DatabaseCredentialRotationService],
})
export class PrismaModule {}
