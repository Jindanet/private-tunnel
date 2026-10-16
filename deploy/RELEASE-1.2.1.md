# PrivateTunnel 1.2.1

Fixes an upgrade regression where a short or placeholder `DASHBOARD_PASSWORD` in the environment prevented server startup even though administrator credentials already existed in the database.

Startup now checks `admin_password_hash` and the legacy `dashboard_password` key first. Existing credentials take precedence and are preserved; the environment bootstrap password is ignored entirely. No `.env` password change or database reset is required for an existing installation.

Only an installation without stored administrator credentials uses and validates `DASHBOARD_PASSWORD`. An empty value still generates a private first-boot password. Initialization failures close database connections, and concurrent callers wait for initialization to finish.

Update the server source and restart the PM2 process. Existing client keys, host mappings and administrator passwords are retained. This release does not change the 1.2 deployment requirements or limitations.
