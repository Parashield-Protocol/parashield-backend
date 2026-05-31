import { Controller, Get, Param, Query } from '@nestjs/common';
import { PolicyService } from './policy.service';

@Controller('policies')
export class PolicyController {
  constructor(private readonly policy: PolicyService) {}

  /** GET /api/v1/policies/products — list all active insurance products */
  @Get('products')
  async getProducts() {
    return { success: true, data: await this.policy.getActiveProducts() };
  }

  /** GET /api/v1/policies/:id — get a single policy by ID */
  @Get(':id')
  async getPolicy(@Param('id') id: string) {
    const policy = await this.policy.getPolicy(id);
    if (!policy) return { success: false, error: 'Policy not found' };
    return { success: true, data: policy };
  }

  /** GET /api/v1/policies?wallet=<address> — get policies for a wallet */
  @Get()
  async getPolicies(@Query('wallet') wallet: string) {
    if (!wallet) return { success: false, error: 'wallet query param required' };
    return { success: true, data: await this.policy.getUserPolicies(wallet) };
  }
}
