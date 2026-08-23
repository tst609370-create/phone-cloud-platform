use scripting additions

on run
	set installCommand to "/bin/cp /usr/local/libexec/phoneproxy-start /usr/local/libexec/phoneproxy-start.v1-backup 2>/dev/null || true; /bin/cp '/Users/ct/PhoneProxy/upgrade-v2/manager.rb' /usr/local/libexec/phoneproxy-start.new; /usr/sbin/chown root:wheel /usr/local/libexec/phoneproxy-start.new; /bin/chmod 700 /usr/local/libexec/phoneproxy-start.new; /bin/mv -f /usr/local/libexec/phoneproxy-start.new /usr/local/libexec/phoneproxy-start"
	try
		do shell script installCommand with administrator privileges
		display dialog "多账号代理组件安装完成。" buttons {"完成"} default button "完成" with icon note with title "PhoneProxy"
	on error errorMessage number errorNumber
		if errorNumber is not -128 then display dialog "安装失败：" & errorMessage buttons {"确定"} default button "确定" with icon stop with title "PhoneProxy"
	end try
end run
