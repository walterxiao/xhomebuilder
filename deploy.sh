#!/bin/bash
set -e
cd "$(dirname "$0")"
git pull origin main
pm2 restart gamehub
pm2 status gamehub
