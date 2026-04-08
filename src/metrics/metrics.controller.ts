import { Controller, Get, Res } from '@nestjs/common';
import type { Response } from 'express';
import { MetricsService } from './metrics.service';

@Controller('metrics')
export class MetricsController {
  constructor(private readonly metrics: MetricsService) {}

  @Get()
  async metricsEndpoint(@Res() res: Response): Promise<void> {
    res.setHeader('Content-Type', this.metrics.metricsContentType());
    res.send(await this.metrics.metricsText());
  }
}
