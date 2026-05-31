import { Module } from '@nestjs/common';
import { PolicyService }    from './policy.service';
import { PolicyController } from './policy.controller';

@Module({
  controllers: [PolicyController],
  providers:   [PolicyService],
  exports:     [PolicyService],
})
export class PolicyModule {}
