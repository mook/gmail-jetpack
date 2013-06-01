/**
 * Requests that force specific sets of cookies
 * This is _not_ modeled after jetpack's sdk/requests; do not confuse the APIs.
 */
"use strict";

const { Class } = require('sdk/core/heritage');
const { Unknown } = require('sdk/platform/xpcom');
const { Cc, Ci, Cr, Cu } = require("chrome");
const { XMLHttpRequest } = require("sdk/net/xhr");

Cu.import("resource://gre/modules/Services.jsm");
Cu.import("resource://gre/modules/XPCOMUtils.jsm");

XPCOMUtils.defineLazyModuleGetter(this, "NetworkHelper",
                                  "resource://gre/modules/devtools/NetworkHelper.jsm");

const { CookieJar, Cookie } = require("./cookiejar");

/**
 * Create a request; all options other than url are optional.
 * @param url {String} The URL to open
 * @param private {Boolean} Is this request private? Defaults to true.
 * @param cookiejar {./cookiejar::CookieJar} The cookie jar to use
 * @param method {String} One of GET or POST; default is GET.
 */
function Request(options) {
    console.log("making new request:", options);

    let isPrivate = "private" in options ? !!options.private : true;
    let method = "method" in options ? options.method : "GET";
    
    this.cookiejar = "cookiejar" in options ? options.cookiejar : new CookieJar();

    this.xhr = new XMLHttpRequest({mozAnon: isPrivate, mozSystem: true});
    this.xhr.addEventListener("load", this.onload.bind(this), false);
    this.xhr.open(method.toUpperCase(), options.url, /*async*/ true);
    this.xhr._req.responseType = "document";
    let channel = this.xhr._req.channel
                      .QueryInterface(Ci.nsIHttpChannelInternal)
                      .QueryInterface(Ci.nsIPrivateBrowsingChannel);
    

    // Setting a load group makes impossible to go private; see bug 877961
    //if (!channel.loadGroup) {
    //    channel.loadGroup = Cc["@mozilla.org/network/load-group;1"]
    //                          .createInstance(Ci.nsILoadGroup);
    //}

    channel.setPrivate(isPrivate);
    this.xhr._req.setRequestHeader("Cookie", this.cookiejar.get(channel.URI).join(";"));

    console.log("about to send request");
    this.xhr.send();
}

Request.prototype._storeCookies = function() {
    let cookieHeader = this.xhr.getResponseHeader("Set-Cookie");
    if (!cookieHeader) {
        return;
    }
    console.log("raw cookies:", cookieHeader);
    let cookies = NetworkHelper.parseSetCookieHeader(cookieHeader);
    for (let cookie of cookies) {
        console.log("cookie:", JSON.stringify(cookie));
        this.cookiejar.add(new Cookie(cookie), this.xhr._req.channel.URI);
    }
};

Request.prototype.onload = function()  {
    try {
        this._storeCookies();
        console.log("load!", this.xhr._req.response, "::", this.cookiejar);
    } catch(e) {
        console.exception(e);
    }
};

exports.Request = Request;
