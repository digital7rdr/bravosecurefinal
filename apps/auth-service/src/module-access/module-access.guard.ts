import {applyDecorators, Injectable, SetMetadata, UseGuards, type CanActivate, type ExecutionContext} from '@nestjs/common';
import {Reflector} from '@nestjs/core';
import {ModuleAccessService} from './module-access.service';
import type {ModuleKey} from './module-catalog';

export const REQUIRE_MODULE_KEY = 'bravo:require_module';

/**
 * Gate a controller class or a single handler behind a product module.
 *
 * Applies the metadata AND binds ModuleAccessGuard. On a class, put it ABOVE the
 * class's `@UseGuards(JwtAuthGuard, …)` line: class decorators apply bottom-up,
 * so the guard lands after JwtAuthGuard and can read req.user. On a handler it
 * runs after every class-level guard by construction.
 * module-access.binding.spec pins both orderings.
 */
export const ModuleGate = (key: ModuleKey) =>
  applyDecorators(SetMetadata(REQUIRE_MODULE_KEY, key), UseGuards(ModuleAccessGuard));

@Injectable()
export class ModuleAccessGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    private readonly access: ModuleAccessService,
  ) {}

  async canActivate(ctx: ExecutionContext): Promise<boolean> {
    const key = this.reflector.getAllAndOverride<ModuleKey | undefined>(
      REQUIRE_MODULE_KEY, [ctx.getHandler(), ctx.getClass()],
    );
    if (!key) {return true;}
    const req = ctx.switchToHttp().getRequest<{user?: {sub?: string}}>();
    const sub = req.user?.sub;
    // Authentication is JwtAuthGuard's job and it runs first (binding spec). A
    // missing sub here means an unauthenticated route that happens to share a
    // gated class — never this guard's call to make.
    if (!sub) {return true;}
    await this.access.assertEnabled(sub, key); // throws 403 module_disabled
    return true;
  }
}
