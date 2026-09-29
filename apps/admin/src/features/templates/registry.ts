import "server-only";
// Template keys are registered by the modules that send them (at import time). The studio needs
// the full registry (variables + example data for previews), so load every registering module here.
import "@cnote/email";
import "@cnote/notifications";
