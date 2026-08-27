import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  Post,
  Query,
  UseGuards,
} from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { CoreAuthGuard } from '../auth/core-auth.guard';
import { CurrentUserId } from '../auth/current-user-id.decorator';
import { HoldsService } from './holds.service';
import { HoldSeatsDto } from './dto/hold-seats.dto';
import { ValidateHoldsQueryDto } from './dto/validate-holds-query.dto';
import { LiveSeatsParamsDto } from './dto/live-seats-params.dto';
import { LiveSeatsDto, ValidateHoldsDto } from './dto/holds-response.dto';
import { InternalPortGuard } from './internal-port.guard';
import { InternalTokenGuard } from './internal-token.guard';
import {
  ApiCreateHold,
  ApiLiveSeats,
  ApiReleaseHold,
  ApiValidateHolds,
} from './holds.swagger';

@ApiTags('holds')
@Controller()
export class HoldsController {
  constructor(private readonly holds: HoldsService) {}

  @ApiCreateHold()
  @UseGuards(CoreAuthGuard)
  @Post('holds')
  async create(
    @Body() dto: HoldSeatsDto,
    @CurrentUserId() userId: number | undefined,
  ): Promise<void> {
    await this.holds.hold(dto, userId);
  }

  @ApiReleaseHold()
  @UseGuards(CoreAuthGuard)
  @HttpCode(HttpStatus.NO_CONTENT)
  @Delete('holds')
  async release(@Body() dto: HoldSeatsDto): Promise<void> {
    await this.holds.release(dto);
  }

  @ApiLiveSeats()
  @Get('events/:id/live-seats')
  liveSeats(@Param() params: LiveSeatsParamsDto): Promise<LiveSeatsDto> {
    return this.holds.liveSeats(params.id);
  }

  @ApiValidateHolds()
  @UseGuards(InternalPortGuard, InternalTokenGuard)
  @Get('internal/holds/validate')
  validate(@Query() query: ValidateHoldsQueryDto): Promise<ValidateHoldsDto> {
    return this.holds.validate(query);
  }
}
