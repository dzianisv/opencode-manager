# Roadmap

This document outlines planned features for OpenCode Manager. Items are subject to change based on community feedback and priorities.

## Phase 1: Authentication (In Progress)

Implementation of a flexible authentication system using [BetterAuth](https://better-auth.com/).

### Planned Features

- **OAuth Providers** - Google, GitHub, GitLab, and other social logins
- **Hardware Keys** - WebAuthn/FIDO2 support for security keys and passkeys
- **OIDC Support** - Custom OpenID Connect provider configuration
- **User-Configurable Auth** - Let users choose which auth methods to enable
- **Session Management** - Secure session handling with refresh tokens
- **Role-Based Access Control** - Foundation for future permission systems

### Technical Scope

- BetterAuth integration with Hono backend
- SQLite schema additions for auth tables
- Frontend auth flows (login, signup, settings)
- Auth middleware for protected routes

---

## Phase 2: PWA & Push Notifications

Installable PWA with real-time push notifications for background alerts.

### Planned Features

- **PWA Installability** - Add to Home Screen on mobile and desktop
- **Real-Time Push Notifications** - Get notified when tasks complete, errors occur, or sessions need attention (even when the app isn't open)
- **Cross-Platform Push** - Works on desktop browsers, Android, and iOS (16.4+)
- **Permission Management** - User-friendly opt-in flow
- **Notification Preferences** - Per-category notification settings

### Use Cases

Push notifications are valuable for long-running operations:
- Task completed or failed while you're in another app
- Session disconnected or requires input
- Background job status updates

### iOS Support Note

Push notifications are fully supported on iOS/iPadOS 16.4+ when the app is installed to the Home Screen:
- App must be added to Home Screen (not just browser)
- Uses standard Web Push API (no Apple Developer account needed)
- Notifications appear on Lock Screen, Notification Center, and Apple Watch

### Technical Scope

- Service Worker for push event handling
- Web Push Protocol implementation (VAPID keys)
- Push subscription storage per user/device
- App manifest for PWA installability


---

## Contributing

Have ideas or feedback on the roadmap? Open an issue or discussion on GitHub.
