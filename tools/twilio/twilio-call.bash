#!/bin/bash
#####################################################################
#
# Copyright (c) 2009 Twilio, Inc.
#
# Permission is hereby granted, free of charge, to any person
# obtaining a copy of this software and associated documentation
# files (the "Software"), to deal in the Software without
# restriction, including without limitation the rights to use,
# copy, modify, merge, publish, distribute, sublicense, and/or sell
# copies of the Software, and to permit persons to whom the
# Software is furnished to do so, subject to the following
# conditions:
#
# The above copyright notice and this permission notice shall be
# included in all copies or substantial portions of the Software.
#
# THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND,
# EXPRESS OR IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES
# OF MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE AND
# NONINFRINGEMENT. IN NO EVENT SHALL THE AUTHORS OR COPYRIGHT
# HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER LIABILITY,
# WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING
# FROM, OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR
# OTHER DEALINGS IN THE SOFTWARE.
#
######################################################################

function usage
{
	if [ -n "$1" ]; then echo $1; fi
	echo "Usage: twilio-call [-v] [-c configfile] [-d callerid] [-u accountsid] [-p authtoken] number [number[number[...]]]"
	exit 1
}

VERBOSE=0

while getopts ":c:u:p:d:v" opt; do
	case "$opt" in
		c) CONFIGFILE=$OPTARG ;;
		d) CALLERID_ARG=$OPTARG ;;
		u) ACCOUNTSID_ARG=$OPTARG ;;
		p) AUTHTOKEN_ARG=$OPTARG ;;
		v) VERBOSE=1 ;;
		*) echo "Unknown param: $opt"; usage ;;
	esac
done

# test configfile
if [ -n "$CONFIGFILE" -a ! -f "$CONFIGFILE" ]; then echo "Configfile not found: $CONFIGFILE"; usage; fi

# source configfile if given
if [ -n "$CONFIGFILE" ]; then . "$CONFIGFILE";
# source the default ~/.twiliorc if it exists
elif [ -f ~/.twiliorc ]; then . ~/.twiliorc;
fi

# if ACCOUNTSID, AUTHTOKEN, or CALLERID were given in the commandline, then override that in the configfile
if [ -n "$ACCOUNTSID_ARG" ]; then ACCOUNTSID=$ACCOUNTSID_ARG; fi
if [ -n "$AUTHTOKEN_ARG" ]; then AUTHTOKEN=$AUTHTOKEN_ARG; fi
if [ -n "$CALLERID_ARG" ]; then CALLERID=$CALLERID_ARG; fi
	
# verify params
if [ -z "$ACCOUNTSID" ]; then usage "AccountSid not set, it must be provided in the config file, or on the command line."; fi;
if [ -z "$AUTHTOKEN" ]; then usage "AuthToken not set, it must be provided in the config file, or on the command line."; fi;
if [ -z "$CALLERID" ]; then usage "CallerID not set, it must be provided in the config file, or on the command line."; fi;

rawurlencode() {
  local string="${1}"
  local strlen=${#string}
  local encoded=""
  local pos c o

  for (( pos=0 ; pos<strlen ; pos++ )); do
     c=${string:$pos:1}
     case "$c" in
        [-_.~a-zA-Z0-9] ) o="${c}" ;;
        * )               printf -v o '%%%02x' "'$c"
     esac
     encoded+="${o}"
  done
  echo "${encoded}"    # You can either set a return variable (FASTER) 
  REPLY="${encoded}"   #+or echo the result (EASIER)... or both... :p
}

# Get message from stdin, and double URLEncode it using a little perl action
MSG=`cat`
MSG="$(rawurlencode "$MSG")"

# Verify MSG
if [ -z "$MSG" ]; then usage "No content for the call was read from STDIN."; fi;

# for each remaining shell arg, that's a phone number to call
for PHONE in "${@:$OPTIND}"; do
	echo -n "Calling $PHONE from $CALLERID..."
	# initiate a curl request to the Twilio REST API, to begin a phone call to that number
    
    ESPONSE=`curl -X POST -F "Url=http://twimlets.com/message?Message=$MSG" -F "From=${CALLERID}" -F "To={$PHONE}" "https://api.twilio.com/2010-04-01/Accounts/${ACCOUNTSID}/Calls" -u "${ACCOUNTSID}:${AUTHTOKEN}" 2>&1`

	if [ $? -gt 0 ]; then echo "Failed to call $PHONE: $RESPONSE"
	else echo "done"
fi
	if [ "$VERBOSE" -eq 1 ]; then echo $RESPONSE; fi
done

