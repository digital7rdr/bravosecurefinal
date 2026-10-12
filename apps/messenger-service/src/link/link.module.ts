import {Module} from '@nestjs/common';
import {AuthModule} from '../auth/auth.module';
import {PushModule} from '../push/push.module';
import {LinkService} from './link.service';
import {LinkController} from './link.controller';

/** Linked devices — browser mirrored from the phone. See link-policy.ts. */
@Module({
  imports:     [AuthModule, PushModule],
  providers:   [LinkService],
  controllers: [LinkController],
  exports:     [LinkService],
})
export class LinkModule {}
