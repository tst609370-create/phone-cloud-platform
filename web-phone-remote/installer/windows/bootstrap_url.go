package main

// Built-in enrollment endpoint. This is not an FRP token. The novice does not
// type it and does not drop a bootstrap.url file. The operator must serve this
// exact URL over a publicly trusted HTTPS certificate. If it is down, local
// install still finishes and the public tunnel stays disconnected.
func defaultBootstrapURL() string {
	return "https://103.205.240.23:7443/v1/register"
}
