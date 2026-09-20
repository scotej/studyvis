/* Exercise the packaged WebKit engine. The caller selects the exact runtime. */
#include <gtk/gtk.h>
#include <webkit2/webkit2.h>

static int result = 1;

static void message(WebKitUserContentManager *manager,
                    WebKitJavascriptResult *javascript_result, gpointer data) {
  (void)manager;
  (void)data;
  char *text = jsc_value_to_string(
      webkit_javascript_result_get_js_value(javascript_result));
  g_print("WebKit media: %s\n", text);
  if (g_str_has_prefix(text, "PASS ")) {
    result = 0;
    gtk_main_quit();
  } else if (g_str_has_prefix(text, "FAIL ")) {
    gtk_main_quit();
  }
  g_free(text);
}

static gboolean timed_out(gpointer data) {
  (void)data;
  g_printerr("WebKit media: FAIL native probe timed out\n");
  gtk_main_quit();
  return G_SOURCE_REMOVE;
}

static void process_terminated(WebKitWebView *view,
                               WebKitWebProcessTerminationReason reason,
                               gpointer data) {
  (void)view;
  (void)data;
  g_printerr("WebKit media: FAIL web process terminated (%d)\n", reason);
  gtk_main_quit();
}

int main(int argc, char **argv) {
  if (argc != 2) {
    g_printerr("usage: %s <check-linux-webkit-media.html>\n", argv[0]);
    return 2;
  }
  char *html = NULL;
  GError *error = NULL;
  if (!g_file_get_contents(argv[1], &html, NULL, &error)) {
    g_printerr("WebKit media: FAIL %s\n", error->message);
    g_error_free(error);
    return 1;
  }
  gtk_init(&argc, &argv);
  WebKitSettings *settings = webkit_settings_new();
  webkit_settings_set_enable_media_stream(settings, TRUE);
  webkit_settings_set_enable_webrtc(settings, TRUE);
  WebKitUserContentManager *manager = webkit_user_content_manager_new();
  webkit_user_content_manager_register_script_message_handler(manager, "probe");
  g_signal_connect(manager, "script-message-received::probe", G_CALLBACK(message), NULL);
  WebKitWebsitePolicies *policies = webkit_website_policies_new_with_policies(
      "autoplay", WEBKIT_AUTOPLAY_ALLOW, NULL);
  GtkWidget *view = g_object_new(WEBKIT_TYPE_WEB_VIEW, "settings", settings,
      "user-content-manager", manager, "website-policies", policies, NULL);
  g_signal_connect(view, "web-process-terminated", G_CALLBACK(process_terminated), NULL);
  GtkWidget *window = gtk_window_new(GTK_WINDOW_TOPLEVEL);
  gtk_window_set_default_size(GTK_WINDOW(window), 800, 600);
  gtk_container_add(GTK_CONTAINER(window), view);
  gtk_widget_show_all(window);
  webkit_web_view_load_html(WEBKIT_WEB_VIEW(view), html, "http://localhost/");
  g_free(html);
  g_timeout_add_seconds(60, timed_out, NULL);
  gtk_main();
  gtk_widget_destroy(window);
  g_object_unref(policies);
  g_object_unref(manager);
  g_object_unref(settings);
  return result;
}
