use framework "AppKit"
use framework "WebKit"
use scripting additions

property mainWindow : missing value
property webView : missing value

on run
	do shell script "if ! /usr/bin/pgrep -f '/Users/ct/PhoneProxy/ui.rb' >/dev/null; then /usr/bin/nohup /usr/bin/ruby /Users/ct/PhoneProxy/ui.rb >/Users/ct/PhoneProxy/ui.log 2>&1 & fi"
	delay 1

	set theApplication to current application's NSApplication's sharedApplication()
	set styleMask to 15
	set windowRect to current application's NSMakeRect(0, 0, 920, 720)
	set mainWindow to current application's NSWindow's alloc()'s initWithContentRect:windowRect styleMask:styleMask backing:2 defer:false
	mainWindow's setTitle:"PhoneProxy"
	mainWindow's setMinSize:(current application's NSMakeSize(620, 520))
	mainWindow's |center|()

	set config to current application's WKWebViewConfiguration's new()
	set contentView to mainWindow's contentView()
	set contentBounds to current application's NSMakeRect(0, 0, 920, 720)
	set webView to current application's WKWebView's alloc()'s initWithFrame:contentBounds configuration:config
	webView's setAutoresizingMask:18
	contentView's addSubview:webView
	set pageURL to current application's NSURL's URLWithString:"http://127.0.0.1:8099/"
	webView's loadRequest:(current application's NSURLRequest's requestWithURL:pageURL)

	mainWindow's makeKeyAndOrderFront:me
	theApplication's activateIgnoringOtherApps:true
end run

on reopen
	if mainWindow is not missing value then
		mainWindow's makeKeyAndOrderFront:me
		current application's NSApp's activateIgnoringOtherApps:true
	end if
end reopen

on idle
	return 2
end idle
