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
import { HoldsService } from './holds.service';
import { HoldSeatsDto } from './dto/hold-seats.dto';
import { ValidateHoldsQueryDto } from './dto/validate-holds-query.dto';
import { LiveSeatsParamsDto } from './dto/live-seats-params.dto';
import { LiveSeatsDto, ValidateHoldsDto } from './dto/holds-response.dto';
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
  @Post('holds')
  create(@Body() dto: HoldSeatsDto): void {
    this.holds.hold(dto);
  }

  @ApiReleaseHold()
  @HttpCode(HttpStatus.NO_CONTENT)
  @Delete('holds')
  release(@Body() dto: HoldSeatsDto): void {
    this.holds.release(dto);
  }

  @ApiLiveSeats()
  @Get('events/:id/live-seats')
  liveSeats(@Param() params: LiveSeatsParamsDto): LiveSeatsDto {
    return this.holds.liveSeats(params.id);
  }

  @ApiValidateHolds()
  @UseGuards(InternalTokenGuard)
  @Get('internal/holds/validate')
  validate(@Query() query: ValidateHoldsQueryDto): ValidateHoldsDto {
    return this.holds.validate(query);
  }
}
