import {
  ArrayMaxSize, ArrayMinSize, IsArray, IsBoolean, IsIn, IsObject, IsOptional, IsString, IsUUID, Length,
  MaxLength, ValidateIf,
} from 'class-validator';
import {CHANNEL_ACCESS, CHANNEL_POST_MODES, type ChannelAccess, type ChannelPostMode} from '../../department/dto/channel.dto';

/** Enterprise structure editor (ops console, 2026-10-15). */

export class CreateStructureNodeDto {
  @IsString() @Length(1, 80)
  name!: string;

  /** Omitted / null = the organisation itself (a level-0 root). */
  @IsOptional() @IsUUID()
  parent_id?: string | null;

  @IsOptional() @IsIn(CHANNEL_POST_MODES as unknown as string[])
  post_mode?: ChannelPostMode;

  /** Default true: create the level's template channels with the node. */
  @IsOptional() @IsBoolean()
  apply_template?: boolean;
}

export class CreateStructureLateralDto {
  @IsUUID()
  parent_id!: string;

  @IsString() @Length(1, 80)
  name!: string;

  @IsOptional() @IsIn(CHANNEL_POST_MODES as unknown as string[])
  post_mode?: ChannelPostMode;
}

export class UpdateStructureChannelDto {
  @IsOptional() @IsString() @Length(1, 80)
  name?: string;

  @IsOptional() @IsIn(CHANNEL_POST_MODES as unknown as string[])
  post_mode?: ChannelPostMode;

  @IsOptional() @IsIn(CHANNEL_ACCESS as unknown as string[])
  access?: ChannelAccess;
}

export class SetChannelTemplatesDto {
  @ValidateIf(o => !o.reset) @IsObject()
  templates?: Record<string, unknown>;

  @IsOptional() @IsBoolean()
  reset?: boolean;
}

export class SetLevelNamesDto {
  @IsArray() @ArrayMaxSize(4) @IsString({each: true}) @MaxLength(24, {each: true})
  names!: string[];
}

export class SetPlacementDto {
  /** null = the whole organisation. */
  @IsOptional() @IsUUID()
  channel_id?: string | null;
}

export class BulkPlacementDto {
  @IsArray() @ArrayMinSize(1) @ArrayMaxSize(200) @IsUUID('all', {each: true})
  user_ids!: string[];

  @IsOptional() @IsUUID()
  channel_id?: string | null;
}
